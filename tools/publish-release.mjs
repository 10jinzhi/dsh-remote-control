/**
 * 把 APK 发布成 GitHub Release 附件。
 *
 * 为什么不把 APK 提交进仓库：仓库里的文件会被 pnpm 打出的 tarball 一并带下去
 * （每次装插件都要多下几十 KB），而且同一个二进制存两处（库里一份、Releases 一份）
 * 迟早不一致。Releases 本身按版本归档，下载页对人也更直白。
 *
 * 用法（token 只从环境变量进，绝不写进仓库）：
 *   GITHUB_TOKEN=ghp_xxx node tools/publish-release.mjs \
 *     --tag android-v1.0.0 \
 *     --title "DSH 远程控制 · 移动端 v1.0.0" \
 *     --apk out/dsh-remote-control-android-1.0.0.apk \
 *     --notes docs/发布说明-移动端.md
 *
 * 重复执行是安全的：release 已存在就复用，同名 asset 已存在就先删再传
 * （GitHub 不允许覆盖同名附件）。这样改一行代码重发同一版不会留下两个包。
 */
import { execFileSync } from 'node:child_process';
import { resolve4 } from 'node:dns/promises';
import { existsSync, readFileSync, statSync } from 'node:fs';
import https from 'node:https';
import { basename, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');

function arg(name, fallback = '') {
	const i = process.argv.indexOf(`--${name}`);
	return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const token = process.env.GITHUB_TOKEN ?? '';
if (token === '') {
	console.error('缺少 GITHUB_TOKEN 环境变量（需要 repo 权限的 personal access token）');
	process.exit(1);
}

/** `owner/repo` —— 默认按 origin 的 GitHub 地址推导，避免手工同步两份。 */
function resolveRepo() {
	const explicit = arg('repo');
	if (explicit) return explicit;
	try {
		const url = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: ROOT, encoding: 'utf8' }).trim();
		const m = /github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?$/.exec(url);
		if (m) return `${m[1]}/${m[2]}`;
	} catch {
		// 落空就报错，别猜一个仓库发出去
	}
	throw new Error('推导不出仓库地址，用 --repo owner/repo 指定');
}

const repo = resolveRepo();
const tag = arg('tag');
const title = arg('title', tag);
const apkPath = resolve(ROOT, arg('apk', ''));
const notesPath = arg('notes');

if (!tag || !arg('apk')) {
	console.error('用法：GITHUB_TOKEN=xxx node tools/publish-release.mjs --tag <tag> --apk <文件> [--title <标题>] [--notes <md 文件>]');
	process.exit(1);
}
if (!existsSync(apkPath)) throw new Error(`APK 不存在：${apkPath}`);

const H = {
	authorization: `Bearer ${token}`,
	accept: 'application/vnd.github+json',
	'x-github-api-version': '2022-11-28',
};

async function call(url, init = {}) {
	const res = await fetch(url, { ...init, headers: { ...H, ...(init.headers ?? {}) } });
	const text = await res.text();
	let body;
	try { body = JSON.parse(text); } catch { body = text; }
	if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${url} → HTTP ${res.status}：${text.slice(0, 300)}`);
	return body;
}

const body = notesPath && existsSync(resolve(ROOT, notesPath))
	? readFileSync(resolve(ROOT, notesPath), 'utf8')
	: `${title}\n\n下载附件 \`${basename(apkPath)}\` 安装即可。`;

/**
 * 上传附件。附件只能发到 `uploads.github.com`，而这个域名在部分网络里
 * Node 的 getaddrinfo 会报 ENOTFOUND（系统 nslookup 却解析得出来，实测就是
 * 这台机器），所以这里不用 fetch，而是自己发 https 请求，失败时用
 * `dns.resolve4` 拿 IP 把 lookup 钉死。SNI 与 Host 仍是 uploads.github.com，
 * 证书校验照旧 —— 只是绕开了坏掉的那一层解析。
 */
function uploadAsset(url, bytes, contentType) {
	const attempt = (ip) => new Promise((res, rej) => {
		const u = new URL(url);
		const req = https.request({
			method: 'POST',
			host: u.hostname,
			path: `${u.pathname}${u.search}`,
			servername: u.hostname,
			headers: { ...H, 'content-type': contentType, 'content-length': String(bytes.length) },
			// net.connect 会按场景传 {all:true}，那时必须回数组；两种签名都得管，
			// 否则会抛 ERR_INVALID_IP_ADDRESS（看着像地址坏了，其实是回调形状不对）。
			...(ip ? {
				lookup: (_h, opts, cb) => (opts && opts.all
					? cb(null, [{ address: ip, family: 4 }])
					: cb(null, ip, 4)),
			} : {}),
		}, (r) => {
			const chunks = [];
			r.on('data', (c) => chunks.push(c));
			r.on('end', () => {
				const text = Buffer.concat(chunks).toString('utf8');
				if (r.statusCode === 200 || r.statusCode === 201) {
					try { res(JSON.parse(text)); } catch { rej(new Error(`附件上传返回非 JSON：${text.slice(0, 200)}`)); }
				} else {
					rej(new Error(`附件上传 HTTP ${r.statusCode}：${text.slice(0, 300)}`));
				}
			});
		});
		req.on('error', rej);
		req.setTimeout(180_000, () => req.destroy(new Error('附件上传超时（180s）')));
		req.end(bytes);
	});

	return attempt(null).catch(async (error) => {
		if (!/ENOTFOUND|EAI_AGAIN/i.test(error.message)) throw error;
		const [ip] = await resolve4('uploads.github.com');
		console.log(`DNS 解析失败，改用直连 ${ip}（SNI/Host 仍是 uploads.github.com）`);
		return attempt(ip);
	});
}


// ① 找已有的 release，没有就建（tag 不存在时 GitHub 会按 target_commitish 自动建）
const existing = await call(`https://api.github.com/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`)
	.catch(() => null);

let release = existing;
if (!release) {
	release = await call(`https://api.github.com/repos/${repo}/releases`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ tag_name: tag, name: title, body, target_commitish: arg('target', 'main') }),
	});
	console.log(`创建 release ${tag}（id=${release.id}）`);
} else {
	// 复用已有 release：说明文字可能更新过，跟着改，附件下面单独处理
	release = await call(`https://api.github.com/repos/${repo}/releases/${release.id}`, {
		method: 'PATCH',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ name: title, body }),
	});
	console.log(`复用 release ${tag}（id=${release.id}）`);
}

// ② 同名附件先删后传：GitHub 不允许覆盖，直接传会 422
const name = basename(apkPath);
for (const asset of release.assets ?? []) {
	if (asset.name === name) {
		await call(`https://api.github.com/repos/${repo}/releases/assets/${asset.id}`, { method: 'DELETE' });
		console.log(`删掉旧附件 ${name}`);
	}
}

const bytes = readFileSync(apkPath);
const uploaded = await uploadAsset(
	`https://uploads.github.com/repos/${repo}/releases/${release.id}/assets?name=${encodeURIComponent(name)}`,
	bytes,
	'application/vnd.android.package-archive',
);

console.log(`\n已发布 ${name}（${(statSync(apkPath).size / 1024).toFixed(1)}KB）`);
console.log(`  页面    ${release.html_url}`);
console.log(`  直链    ${uploaded.browser_download_url}`);
