/**
 * 校验「GitHub 链接能装」这件事所依赖的仓库形态。
 *
 * 官方安装器不 clone、不扫描子目录：它把链接原样交给 `pnpm add`，然后只认
 * **装出来的那个包的根 `package.json`**。所以仓库根必须自己就是 bundle 包，
 * 且 `dsh.bundle.patch` 指向的文件、`lib/` 都必须真的被打进包里 ——
 * 任何一条不满足，用户那边的症状都是「粘贴链接 → 装完报 not-bundle → 回滚」，
 * 而且报错不告诉你是哪一个文件没带。
 *
 * 「装得上」之后还得「启得动」：web-boot 会把 `exports['./client']` 当普通 script
 * 注入，再实例化它注册的 factory。手写的客户端脚本一旦引用了未声明的 CJS
 * 全局（最典型是漏写 `var exports = module.exports`），语法检查全过、安装也成功，
 * 但启动直接 `exports is not defined` ⇒ 整个 entry 判为 did not activate。
 * 所以末尾几项会**真的执行一遍 factory**，而不是只看文件在不在。
 *
 * 这条检查放在全量回归最前面：结构被改坏的代价，比任何协议 bug 都大。
 *
 * 运行：node tools/install-shape.mjs
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { runInNewContext } from 'node:vm';

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
	assert(hosted.test('https://github.com/10jinzhi/dsh-remote-control#v1.0.1'), '钉版本链接不匹配');
	assert(!hosted.test('https://github.com/10jinzhi/dsh-remote-control/tree/main/lib'),
		'子目录链接本应被拒（所以仓库根必须就是包）');
});

// ---------------------------------------------------------------- 客户端半边
//
// host 侧（client-modules/src/index.ts）按 `dsh.client.platform === 'web'` 收集
// 客户端入口，路径取 `exports['./client']`，作为 script 注入 web 页面。
// 这一段模拟的正是这个加载过程。

let clientRegistration = null;

check('dsh.client 声明与 exports["./client"] 能被 host 侧解析', () => {
	const decl = pkg.dsh?.client;
	assert(decl && typeof decl === 'object', '缺 dsh.client 声明');
	assert(decl.platform === 'web', `platform 是 ${decl.platform}，host 侧只收 web`);
	assert(decl.inject === undefined || Array.isArray(decl.inject), 'dsh.client.inject 不是数组');
	const client = pkg.exports?.['./client'];
	const rel = typeof client === 'string' ? client : client?.default;
	assert(typeof rel === 'string', 'exports["./client"] 不是字符串或带 default 的对象');
	assert(existsSync(resolve(ROOT, rel)), `${rel} 不在磁盘上`);
	assert(packed !== null && packed.includes(rel.replace(/^\.\//, '')),
		`${rel} 没被打进包，装完 web-boot 会 404`);
	return rel;
});

check('客户端脚本能注册 factory，且 factory 实例化不抛异常', () => {
	const src = readFileSync(join(ROOT, 'lib/client.js'), 'utf8');
	// 只给 window：不给 require / exports / process。漏写 `var exports = ...`
	// 时，factory 里的赋值会在这里原样抛出 ReferenceError —— 这正是 web-boot
	// 报 `import failed: exports is not defined` 的成因。
	runInNewContext(src, {
		window: { __ModuleLoader__: { load: (r) => { clientRegistration = r; } } },
		fetch: () => { throw new Error('顶层不该发请求'); },
		console,
	});
	assert(clientRegistration !== null, '脚本没有调用 window.__ModuleLoader__.load');
	assert(clientRegistration.id === pkg.name,
		`注册 id 是 ${clientRegistration.id}，与包名 ${pkg.name} 不一致`);
	assert(typeof clientRegistration.factory === 'function', '没有 factory');

	const noop = () => ({});
	const fakeReact = {
		createElement: noop,
		useState: () => [null, noop],
		useCallback: (fn) => fn,
		useEffect: noop,
	};
	const fakePrimitives = { Button: noop, Pill: noop };
	const requireStub = (id) => {
		if (id === 'react') return fakeReact;
		if (id === '@deepseek-ai/dsh-client-ui-primitives') return fakePrimitives;
		throw new Error(`客户端脚本请求了未声明的外部模块：${id}`);
	};

	const face = clientRegistration.factory(requireStub);
	assert(face && typeof face === 'object', 'factory 没有返回模块对象');
	assert(typeof face.apply === 'function', '缺 apply');
	assert(Array.isArray(face.inject), 'inject 不是数组');
	return `注册 ${clientRegistration.id}，导出 ${Object.keys(face).join('/')}`;
});

check('apply 能注入设置页 slot 并注册面板组件', () => {
	assert(clientRegistration !== null, '上一步没跑');
	const face = clientRegistration.factory((id) => {
		if (id === 'react') return { createElement: () => ({}), useState: () => [null, () => {}],
			useCallback: (fn) => fn, useEffect: () => {} };
		if (id === '@deepseek-ai/dsh-client-ui-primitives') return { Button: () => ({}), Pill: () => ({}) };
		throw new Error(`未声明的外部模块：${id}`);
	});
	let slot = null;
	let cell = null;
	face.apply({
		slots: {
			inject: (name, fn) => { slot = name; fn(); },
			register: (meta, Component) => { cell = { meta, Component }; return () => {}; },
		},
	});
	assert(slot === 'settings.section', `注入到 ${slot}，不是设置页`);
	assert(cell && typeof cell.Component === 'function', '没注册面板组件');
	assert(cell.meta.label === 'DSH 远程控制', `面板标题是 ${cell.meta.label}`);
	return slot;
});

check('两个入口都能被各自的运行时解析（ESM 语法检查）', () => {
	for (const f of ['lib/index.js', 'lib/client.js']) {
		const r = spawnSync(process.execPath, ['--check', join(ROOT, f)], { encoding: 'utf8' });
		assert(r.status === 0, `${f}：${String(r.stderr).trim().slice(0, 160)}`);
	}
});

console.log(`\n== 结果：${passed}/${passed + failures.length} 通过 ==`);
if (failures.length > 0) {
	console.log(`  失败：${failures.join('、')}`);
	process.exitCode = 1;
}
