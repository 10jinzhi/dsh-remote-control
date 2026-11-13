/**
 * 校验「GitHub 链接能装」这件事所依赖的仓库形态。
 *
 * 官方安装器不 clone、不扫描子目录：它把链接原样交给 `pnpm add`，然后只认
 * **装出来的那个包的根 `package.json`**。所以仓库根必须自己就是 bundle 包，
 * 且 `dsh.bundle.patch` 指向的文件、`lib/` 都必须真的被打进包里 ——
 * 任何一条不满足，用户那边的症状都是「粘贴链接 → 装完报 not-bundle → 回滚」，
 * 而且报错不告诉你是哪一个文件没带。
 *
 * 这条检查放在全量回归最前面：结构被改坏的代价，比任何协议 bug 都大。
 *
 * 运行：node tools/install-shape.mjs
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
let passed = 0;
const failures = [];

function check(name, fn) {
	try {
		const note = fn();
		passed++;
		console.log(`  ✅ ${name}${note ? `  ${note}` : ''}`);
	} catch (error) {
		failures.push(name);
		console.log(`  ❌ ${name}  ${error.message}`);
	}
}

function assert(ok, message) {
	if (!ok) throw new Error(message);
}

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

console.log('== GitHub 链接安装形态 ==\n');

check('根 package.json 是这个插件包本身（不是 monorepo 根清单）', () => {
	assert(pkg.name === 'dsh-remote-control-desktop', `name 是 ${pkg.name}`);
	assert(typeof pkg.version === 'string' && pkg.version !== '', '缺 version');
	assert(pkg.private !== true, 'private:true 会被市场索引排除');
	return `${pkg.name}@${pkg.version}`;
});

check('声明了 dsh.bundle.patch 且指向的文件真实存在', () => {
	const patch = pkg.dsh?.bundle?.patch;
	assert(typeof patch === 'string' && patch.length > 0, '缺 dsh.bundle.patch');
	assert(existsSync(resolve(ROOT, patch)), `${patch} 不在磁盘上`);
	return patch;
});

check('patch 里有 insert 行，且 name 能被解析回这个包', () => {
	const patch = readFileSync(resolve(ROOT, pkg.dsh.bundle.patch), 'utf8');
	assert(/^\s*-\s*insert\s*:/m.test(patch), '没有 insert 段');
	assert(patch.includes(`name: '${pkg.name}'`) || patch.includes(`name: "${pkg.name}"`),
		`insert.name 不是 ${pkg.name}，loader 会找不到模块`);
	assert(pkg.main === './lib/index.js', 'main 没指向 lib/index.js');
});

check('files 白名单覆盖运行时必需的三样，且不写 prepare', () => {
	const files = pkg.files ?? [];
	for (const need of ['lib', 'cordis.patch.yml', 'README.md']) {
		assert(files.includes(need), `files 缺 ${need}`);
	}
	// git 依赖装的是源码，pnpm ≥10 遇到 prepare 会先拦一道 build-blocked，
	// 用户得手动批准才能装完 —— 纯 JS 包没有构建步骤，干脆不声明脚本。
	assert(!pkg.scripts?.prepare && !pkg.scripts?.prepack, '存在 prepare/prepack，会触发 build-blocked');
	assert(!existsSync(join(ROOT, '.npmignore')), '.npmignore 会覆盖 files 白名单');
});

// npm pack 与 pnpm 对 git 依赖的打包都走 npm-packlist；用 --dry-run 看真实结果，
// 比照着 package.json 自己猜可靠。
let packed = null;
check('npm pack 实际打出来的文件清单', () => {
	const result = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm',
		['pack', '--dry-run', '--json'], { cwd: ROOT, encoding: 'utf8', shell: true });
	assert(result.status === 0, `npm pack 失败：${String(result.stderr).slice(0, 160)}`);
	const stdout = String(result.stdout);
	const start = stdout.indexOf('[');
	assert(start >= 0, '拿不到 JSON 输出');
	packed = JSON.parse(stdout.slice(start))[0].files.map((f) => f.path.replace(/\\/g, '/'));
	return `${packed.length} 个文件`;
});

check('打包结果里 plugin 入口、patch、设置页都在', () => {
	assert(packed !== null, '上一步没跑');
	for (const need of ['package.json', 'cordis.patch.yml', 'lib/index.js',
		'lib/client.js', 'lib/mail7z/settings.js', 'lib/mail7z/bridge.js']) {
		assert(packed.includes(need), `缺 ${need}`);
	}
});

check('打包结果里没有 APK 源码、工具链、文档、凭据', () => {
	assert(packed !== null, '上一步没跑');
	const forbidden = packed.filter((p) =>
		/^(android|tools|docs|out|_toolchain|_node_modules)\//.test(p)
		|| /config\.json|\.keystore|\.env|state\.json/i.test(p));
	assert(forbidden.length === 0, `混进了：${forbidden.join(', ')}`);
});

check('GitHub 仓库链接能被安装器判成 git spec', () => {
	// 与 plugin-manager/src/install-spec.ts 的 HOSTED_REPOSITORY_URL 同形：
	// owner/repo 之后只允许 .git 与 #fragment，不允许 /tree/main/子目录。
	const hosted = /^https?:\/\/[^/]+\/[^/]+\/[^/#]+(?:\.git)?(?:#.*)?$/i;
	assert(hosted.test('https://github.com/10jinzhi/dsh-remote-control'), '普通仓库链接不匹配');
	assert(hosted.test('https://github.com/10jinzhi/dsh-remote-control#v1.0.0'), '钉版本链接不匹配');
	assert(!hosted.test('https://github.com/10jinzhi/dsh-remote-control/tree/main/lib'),
		'子目录链接本应被拒（所以仓库根必须就是包）');
});

console.log(`\n== 结果：${passed}/${passed + failures.length} 通过 ==`);
if (failures.length > 0) {
	console.log(`  失败：${failures.join('、')}`);
	process.exitCode = 1;
}
