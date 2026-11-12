/**
 * 一键跑全部检查 —— 提交前 / 改完协议后跑这一个就够。
 *
 * ```
 *   node tools/test-all.mjs            本地桩，不花 B2 配额（日常）
 *   node tools/test-all.mjs --real     真 Backblaze B2（发版验收）
 *   node tools/test-all.mjs --no-apk   跳过 APK 构建（只想验协议时）
 * ```
 *
 * 顺序是刻意的：先静态（语法/界面脚本），再接口，再协议，最后打包 ——
 * 任何一层挂了都不必等后面的长流程。
 */
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const forward = args.filter((a) => a === '--real');
const skipApk = args.includes('--no-apk');

const suites = [
	{ name: '界面脚本冒烟', file: 'tools/ui-smoke.mjs', args: [] },
	{ name: '电脑端设置接口', file: 'tools/settings-smoke.mjs', args: forward },
	{ name: '传输层端到端（Node 手机模拟器）', file: 'tools/e2e.mjs', args: forward },
	{ name: '客户端端到端（Java 手机核心）', file: 'tools/e2e-app.mjs', args: forward },
	...(skipApk ? [] : [{ name: 'APK 构建', file: 'tools/build-apk.mjs', args: [] }]),
];

const summary = [];
console.log(`== 全量检查（后端：${forward.length > 0 ? '真 B2' : '本地桩'}） ==\n`);

for (const suite of suites) {
	const started = Date.now();
	console.log(`\n──── ${suite.name} ────`);
	const result = spawnSync(process.execPath, [join(ROOT, suite.file), ...suite.args], {
		cwd: ROOT,
		stdio: 'inherit',
	});
	const ms = Date.now() - started;
	const pass = result.status === 0;
	summary.push({ name: suite.name, pass, ms });
}

console.log('\n== 汇总 ==');
for (const row of summary) {
	console.log(`  ${row.pass ? '✅' : '❌'} ${row.name.padEnd(34, ' ')} ${(row.ms / 1000).toFixed(1)}s`);
}
const failed = summary.filter((r) => !r.pass);
const totalMs = summary.reduce((sum, r) => sum + r.ms, 0);
console.log(`\n  ${summary.length - failed.length}/${summary.length} 组通过，共 ${(totalMs / 1000).toFixed(1)}s`);
if (failed.length > 0) {
	console.log('  失败：' + failed.map((f) => f.name).join('、'));
	process.exitCode = 1;
}
