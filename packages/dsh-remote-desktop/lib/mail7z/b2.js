/**
 * Backblaze B2 Native API 的最小封装 —— 零第三方依赖。
 *
 * 为什么用 Native API 而不是 S3 兼容 API：限定 bucket 的 Application Key 在
 * `b2_authorize_account` 里直接返回 apiUrl / downloadUrl / bucketId，
 * 不需要自己配 endpoint、region，也不需要 AWS SigV4 签名。
 *
 * 手机端（Java）有一份行为等价的实现（`dshremote/B2Client.java`），
 * 两边只共用 B2 的公开 API，不共用代码。
 */
import { createHash } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';

const API = '/b2api/v3/';
const DEFAULT_TIMEOUT = 20_000;

/**
 * 授权地址。
 *
 * 生产环境永远是官方域名；`DSH_REMOTE_B2_AUTH` 只给自动化测试用
 * （`tools/local-b2.mjs` 这个本地桩），这样回归测试不消耗真桶的
 * transaction 配额。桩会把 apiUrl / downloadUrl 指向自己，
 * 于是后面的所有调用自动跟着走，这里只留一个口子。
 */
function authorizeUrl() {
	const override = process.env.DSH_REMOTE_B2_AUTH;
	return typeof override === 'string' && override !== ''
		? override
		: 'https://api.backblazeb2.com/b2api/v3/b2_authorize_account';
}

/** 发一次 HTTP 请求，返回 `{ status, headers, body: Buffer }`。 */
export function rawRequest(url, options = {}) {
	const { method = 'GET', headers = {}, body = null, timeout = DEFAULT_TIMEOUT } = options;
	return new Promise((resolve, reject) => {
		let u;
		try {
			u = new URL(url);
		} catch {
			reject(new Error(`B2 请求地址非法: ${url}`));
			return;
		}
		const mod = u.protocol === 'https:' ? https : http;
		let settled = false;
		const req = mod.request(u, { method, headers }, (res) => {
			const chunks = [];
			res.on('data', (c) => chunks.push(c));
			res.on('end', () => {
				if (settled) return;
				settled = true;
				resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) });
			});
			res.on('error', (e) => { if (!settled) { settled = true; reject(e); } });
		});
		req.setTimeout(timeout, () => req.destroy(new Error(`B2 请求超时（${timeout}ms）`)));
		req.on('error', (e) => { if (!settled) { settled = true; reject(e); } });
		if (body !== null) req.write(body);
		req.end();
	});
}

function jsonOf(res, label) {
	try {
		return JSON.parse(res.body.toString('utf8'));
	} catch {
		throw new Error(`${label} 返回的不是 JSON：${res.body.toString('utf8').slice(0, 180)}`);
	}
}

export class B2Client {
	/**
	 * @param cfg - `{ appKeyId, appKey, bucket }`
	 * @param logger - 可选的日志函数（只用于排障，不打印任何密钥）
	 */
	constructor(cfg, logger) {
		this.cfg = cfg;
		this.log = logger ?? (() => {});
		this.auth = null;
		this.uploadInfo = null;
		/** 某些网络访问 f005 下载域会 TLS 中断；一旦确认就别每次白撞一次。 */
		this.directBroken = false;
	}

	/** 授权；缓存 23 小时，401 时强制刷新。 */
	async authorize(force = false) {
		if (!force && this.auth && Date.now() < this.auth.expiresAt) return this.auth;
		const { appKeyId, appKey, bucket } = this.cfg;
		if (!appKeyId || !appKey || !bucket) {
			throw new Error('B2 凭据不完整（需要 Application Key ID / Application Key / Bucket）');
		}
		const basic = Buffer.from(`${appKeyId}:${appKey}`).toString('base64');
		const res = await rawRequest(authorizeUrl(), {
			headers: { Authorization: `Basic ${basic}` },
		});
		if (res.status !== 200) {
			throw new Error(
				`B2 授权失败 HTTP ${res.status}：${res.body.toString('utf8').slice(0, 200)}` +
				'（检查 keyID/applicationKey 是否成对、是否被删、桶是否还在）',
			);
		}
		const d = jsonOf(res, 'b2_authorize_account');
		const storage = d.apiInfo?.storageApi ?? {};
		this.auth = {
			token: d.authorizationToken,
			accountId: d.accountId,
			apiUrl: String(d.apiUrl || storage.apiUrl || '').replace(/\/+$/, ''),
			downloadUrl: String(d.downloadUrl || storage.downloadUrl || '').replace(/\/+$/, ''),
			bucketId: storage.bucketId || null,
			expiresAt: Date.now() + 23 * 3600 * 1000,
		};
		if (!this.auth.bucketId) {
			const listed = await this.api('b2_list_buckets', { accountId: d.accountId }, true);
			const hit = (listed.buckets ?? []).find((b) => b.bucketName === bucket);
			if (!hit) throw new Error(`账号下找不到 bucket「${bucket}」`);
			this.auth.bucketId = hit.bucketId;
		}
		this.log(`B2 授权成功 accountId=${this.auth.accountId} bucket=${bucket}`);
		return this.auth;
	}

	/** 调一条 B2 JSON API；401 时重新授权并重试一次。 */
	async api(action, payload, skipRetry = false) {
		const a = await this.authorize();
		const url = `${a.apiUrl}${API}${action}`;
		const send = (token) => rawRequest(url, {
			method: 'POST',
			headers: { Authorization: token, 'content-type': 'application/json' },
			body: Buffer.from(JSON.stringify(payload)),
		});
		let res = await send(a.token);
		if (res.status === 401 && !skipRetry) {
			const fresh = await this.authorize(true);
			res = await send(fresh.token);
		}
		if (res.status !== 200) {
			throw new Error(`${action} 失败 HTTP ${res.status}：${res.body.toString('utf8').slice(0, 220)}`);
		}
		return jsonOf(res, action);
	}

	/** 上传 URL 可复用（B2 官方建议），失败/401 时重新取。 */
	async getUploadUrl(force = false) {
		if (!force && this.uploadInfo && Date.now() < this.uploadInfo.expiresAt) return this.uploadInfo;
		const d = await this.api('b2_get_upload_url', { bucketId: (await this.authorize()).bucketId });
		this.uploadInfo = { url: d.uploadUrl, token: d.authorizationToken, expiresAt: Date.now() + 12 * 3600 * 1000 };
		return this.uploadInfo;
	}

	/** 上传一个对象（key 整体 encodeURIComponent，和官方示例一致）。 */
	async put(key, bytes) {
		const payload = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
		const sha1 = createHash('sha1').update(payload).digest('hex');
		let lastError = '';
		// 网络类抖动（ECONNRESET / socket hang up）是 throw 出来的，不是非 200，
		// 所以必须 try/catch + 退避重试，只判 status 会漏掉最常见的一类。
		for (let attempt = 0; attempt < 3; attempt += 1) {
			try {
				const up = await this.getUploadUrl(attempt > 0);
				const res = await rawRequest(up.url, {
					method: 'POST',
					headers: {
						Authorization: up.token,
						'X-Bz-File-Name': encodeURIComponent(key),
						'Content-Type': 'b2/x-auto',
						'Content-Length': String(payload.length),
						'X-Bz-Content-Sha1': sha1,
					},
					body: payload,
				});
				if (res.status === 200) return jsonOf(res, 'b2_upload_file');
				lastError = `HTTP ${res.status}：${res.body.toString('utf8').slice(0, 180)}`;
			} catch (error) {
				lastError = error.message;
			}
			this.uploadInfo = null;
			if (attempt < 2) await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
		}
		throw new Error(`B2 上传失败（重试 3 次）：${lastError}`);
	}

	/**
	 * 直连下载。优先 `downloadUrl/file/<bucket>/<key>`（一次 GET，只计流量）；
	 * 失败时回退 `b2_download_file_by_id`（实测某些代理访问下载域会 TLS 中断）。
	 *
	 * @returns Buffer，对象不存在返回 null。
	 */
	async get(key) {
		const a = await this.authorize();
		if (!this.directBroken) {
			const direct = `${a.downloadUrl}/file/${encodeURIComponent(this.cfg.bucket)}/${encodeURIComponent(key)}`;
			let res;
			try {
				res = await rawRequest(direct, { headers: { Authorization: a.token, 'cache-control': 'no-cache' } });
			} catch (error) {
				this.directBroken = true;
				this.log(`B2 下载域不可达（${error.message}），后续走 apiUrl 的 byId 兜底`);
			}
			if (res?.status === 200) return res.body;
			if (res?.status === 404) return null;
		}
		const listed = await this.api('b2_list_file_names', {
			bucketId: a.bucketId, prefix: key, maxFileCount: 10,
		});
		const hit = (listed.files ?? []).find((f) => f.fileName === key);
		if (!hit) return null;
		const byId = `${a.apiUrl}${API}b2_download_file_by_id?fileId=${encodeURIComponent(hit.fileId)}`;
		const r2 = await rawRequest(byId, { headers: { Authorization: a.token } });
		if (r2.status === 200) return r2.body;
		if (r2.status === 404) return null;
		throw new Error(`${key} 下载失败 HTTP ${r2.status}`);
	}

	/**
	 * 列前缀下的最新对象（按名字升序）。
	 *
	 * `startFileName` 让我们能「从游标之后开始列」，不用把整个队列都拉回来 ——
	 * 这是把轮询开销压到 1 次 Class C 调用的关键。
	 */
	async list(prefix, { startFileName, maxFileCount = 64 } = {}) {
		const a = await this.authorize();
		const payload = { bucketId: a.bucketId, prefix, maxFileCount };
		if (typeof startFileName === 'string' && startFileName !== '') payload.startFileName = startFileName;
		const d = await this.api('b2_list_file_names', payload);
		return d.files ?? [];
	}

	async deleteVersion(fileName, fileId) {
		try {
			await this.api('b2_delete_file_version', { fileName, fileId });
			return true;
		} catch (error) {
			this.log(`删除对象失败 ${fileName}: ${error.message}`);
			return false;
		}
	}

	async deletePrefix(prefix) {
		const files = await this.list(prefix, { maxFileCount: 1000 });
		let n = 0;
		for (const f of files) if (await this.deleteVersion(f.fileName, f.fileId)) n += 1;
		return n;
	}
}
