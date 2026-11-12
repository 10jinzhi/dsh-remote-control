/**
 * 把 Backblaze B2 凭据 + 一个 7z 密码写进本机配置（**不入库**）。
 *
 * 用法：
 *   node tools/set-credentials.mjs --from <b2-credentials.json> --password '<7z密码>' [--cloud-file dsh-remote]
 *   node tools/set-credentials.mjs --key-id 005f... --app-key K005... --bucket my-bucket --password '...'
 *
 * 写出位置：`$DSH_HOME/dsh-remote/config.json`（默认 `~/.dsh/...`，权限 0600）。
 * 这份文件就是电脑端的「配对信息」，手机端在设置里填同样五项即可。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

function parseArgs(argv) {
	const out = {};
	for (let i = 0; i < argv.length; i += 1) {
		const key = argv[i];
		if (!key.startsWith('--')) continue;
		const name = key.slice(2);
		const next = argv[i + 1];
		if (next === undefined || next.startsWith('--')) out[name] = true;
		else { out[name] = next; i += 1; }
	}
	return out;
}

const args = parseArgs(process.argv.slice(2));
const home = process.env.DSH_HOME && process.env.DSH_HOME.trim() !== ''
	? process.env.DSH_HOME.trim()
	: join(homedir(), '.dsh');
const dir = join(home, 'dsh-remote');
const path = join(dir, 'config.json');

let source = {};
if (typeof args.from === 'string') {
	if (!existsSync(args.from)) {
		console.error(`找不到凭据文件：${args.from}`);
		process.exit(1);
	}
	source = JSON.parse(readFileSync(args.from, 'utf8'));
}

const appKeyId = String(args['key-id'] ?? source.keyId ?? source.B2_KEY_ID ?? '').trim();
const appKey = String(args['app-key'] ?? source.applicationKey ?? source.B2_APPLICATION_KEY ?? '').trim();
const bucket = String(args.bucket ?? source.bucket ?? source.B2_BUCKET ?? '').trim();
const cloudFile = String(args['cloud-file'] ?? source.cloudFile ?? 'dsh-remote').trim();
// 没给密码就随机生成一个，打出来——两端都要用它，别弄丢。
const password = typeof args.password === 'string'
	? args.password
	: randomBytes(9).toString('base64url');

if (!appKeyId || !appKey || !bucket) {
	console.error('缺参数：需要 Application Key ID / Application Key / Bucket（--from 或 --key-id/--app-key/--bucket）');
	process.exit(1);
}

mkdirSync(dir, { recursive: true, mode: 0o700 });
const config = { appKeyId, appKey, bucket, cloudFile, password, updatedAt: Date.now() };
writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
try { chmodSync(path, 0o600); } catch { /* Windows 上忽略 */ }

console.log('已写入本机配置：');
console.log(`  文件          ${path}`);
console.log(`  Application Key ID  ${appKeyId}`);
console.log(`  Bucket        ${bucket}`);
console.log(`  云端文件名    ${cloudFile}`);
console.log(`  7z 密码       ${password}`);
console.log('\n手机 APK 的「设置」里填同样这五项（密码逐字一致，区分大小写与空格）。');
