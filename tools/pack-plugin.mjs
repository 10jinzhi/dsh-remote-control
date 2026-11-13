/**
 * 打包电脑端插件 —— 产出一个可以直接交给 DSH 安装的 zip。
 *
 * 仓库**根目录本身就是那个 bundle 包**（官方安装器把 GitHub 链接交给 pnpm，
 * 只认装出来的包的根 package.json，不会扫描子目录），所以这里直接从根取
 * `lib/` + `cordis.patch.yml` + `package.json` + `README.md`，
 * 与 package.json 的 `files` 字段一致。
 *
 * 额外确认：zip 里没有 node_modules、没有 `.env`、没有任何 `config.json`
 * —— 凭据永远只存在使用者的 `$DSH_HOME` 里，不进发行包。
 *
 * 运行：node tools/pack-plugin.mjs
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const SRC = ROOT;
const OUT = join(ROOT, 'out');
const SEVEN_ZIP = process.env.DSH_REMOTE_7Z ?? 'C:/Program Files/7-Zip/7z.exe';

function main() {
	const pkg = JSON.parse(readFileSync(join(SRC, 'package.json'), 'utf8'));
	const zipPath = join(OUT, `${pkg.name}-${pkg.version}.zip`);
	mkdirSync(OUT, { recursive: true });

	if (!existsSync(SEVEN_ZIP)) throw new Error(`找不到 7z：${SEVEN_ZIP}`);
	execFileSync(SEVEN_ZIP, [
		'a', '-tzip', '-mx=9',
		zipPath,
		// 只放发行需要的四样，其余（.map / 测试 / 临时文件）一律不带
		join(SRC, 'package.json'),
		join(SRC, 'cordis.patch.yml'),
		join(SRC, 'README.md'),
		join(SRC, 'lib'),
	], { stdio: ['ignore', 'pipe', 'pipe'] });

	// 反查：确认里面没有任何凭据类文件
	const listing = execFileSync(SEVEN_ZIP, ['l', '-ba', zipPath], { encoding: 'utf8' });
	const entries = listing.split('\n').map((l) => l.trim()).filter(Boolean);
	const forbidden = entries.filter((e) => /config\.json|node_modules|\.env|\.keystore|state\.json/i.test(e));
	if (forbidden.length > 0) {
		throw new Error(`发行包里出现了不该有的文件：\n${forbidden.join('\n')}`);
	}

	const files = entries.filter((e) => !e.endsWith('/'));
	console.log('== 打包完成 ==');
	console.log(`  文件   ${zipPath}`);
	console.log(`  大小   ${(statSync(zipPath).size / 1024).toFixed(1)}KB`);
	console.log(`  条目   ${files.length} 个：`);
	for (const entry of files) {
		const name = entry.split(/\s+/).pop() ?? entry;
		console.log(`         ${name.replace(/\\/g, '/')}`);
	}
	return zipPath;
}

try {
	main();
} catch (error) {
	console.error(`打包失败：${error.message}`);
	process.exit(1);
}
