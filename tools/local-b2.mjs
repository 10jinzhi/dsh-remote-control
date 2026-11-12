/**
 * 本地 B2 兼容桩 —— 让端到端测试不再消耗真桶的 transaction 配额。
 *
 * 只实现本项目真正用到的 7 个动作：
 *
 *   GET  /b2api/v3/b2_authorize_account      授权（返回 apiUrl / downloadUrl / bucketId）
 *   POST /b2api/v3/b2_get_upload_url         取上传地址
 *   POST /b2api/v3/b2_upload_file            上传（X-Bz-File-Name / X-Bz-Content-Sha1）
 *   POST /b2api/v3/b2_list_file_names        列前缀（prefix / startFileName / maxFileCount）
 *   GET  /b2api/v3/b2_download_file_by_id    按 id 下载
 *   POST /b2api/v3/b2_delete_file_version    删对象
 *   GET  /file/<bucket>/<key>                直连下载（与官方路径形状一致）
 *
 * **不校验**签名、密钥、SHA-1 —— 它验证的是「两端的 B2 客户端有没有按协议说话」，
 * 不是 B2 服务本身。真实桶的验收仍由 `node tools/e2e.mjs --real` 负责。
 *
 * 语义上只保留「同名对象后写覆盖」这一条：B2 实际是版本化存储，
 * 但本项目的对象名里带单调序号，永远不会重名。
 */
import { createServer } from 'node:http';

const API = '/b2api/v3/';

export function startLocalB2({ port = 0, bucket = 'local-bucket' } = {}) {
	/** fileName → { fileId, bytes, uploadTimestamp } */
	const objects = new Map();
	let nextId = 1;
	let base = '';

	const json = (res, code, value) => {
		const body = Buffer.from(JSON.stringify(value), 'utf8');
		res.writeHead(code, { 'content-type': 'application/json', 'content-length': String(body.length) });
		res.end(body);
	};

	const filesOf = (prefix, startFileName, maxFileCount) => {
		const names = [...objects.keys()]
			.filter((name) => name.startsWith(prefix))
			.filter((name) => startFileName === undefined || name >= startFileName)
			.sort();
		return names.slice(0, maxFileCount).map((name) => {
			const o = objects.get(name);
			return {
				fileName: name,
				fileId: o.fileId,
				contentLength: o.bytes.length,
				contentType: 'b2/x-auto',
				action: 'upload',
				uploadTimestamp: o.uploadTimestamp,
			};
		});
	};

	const server = createServer((req, res) => {
		const rawUrl = req.url ?? '/';
		const queryAt = rawUrl.indexOf('?');
		const rawPath = queryAt < 0 ? rawUrl : rawUrl.slice(0, queryAt);
		const query = new URLSearchParams(queryAt < 0 ? '' : rawUrl.slice(queryAt + 1));
		// 路径里带 %2F 编码的对象名，解码后才是真实的 key
		let path;
		try {
			path = decodeURIComponent(rawPath);
		} catch {
			path = rawPath;
		}

		const chunks = [];
		req.on('data', (c) => chunks.push(c));
		req.on('end', () => {
			const body = Buffer.concat(chunks);

			if (path.endsWith('/b2_authorize_account')) {
				return json(res, 200, {
					accountId: 'local-account',
					authorizationToken: 'local-token',
					apiUrl: base,
					downloadUrl: base,
					recommendedPartSize: 100_000_000,
					absoluteMinimumPartSize: 5_000_000,
					apiInfo: { storageApi: { apiUrl: base, downloadUrl: base, bucketId: 'local-bucket-id' } },
				});
			}

			if (path.endsWith('/b2_get_upload_url')) {
				return json(res, 200, {
					bucketId: 'local-bucket-id',
					uploadUrl: `${base}${API}b2_upload_file`,
					authorizationToken: 'local-upload-token',
				});
			}

			if (path.endsWith('/b2_upload_file')) {
				const name = decodeURIComponent(req.headers['x-bz-file-name'] ?? '');
				if (name === '') return json(res, 400, { code: 'bad_request', message: 'missing X-Bz-File-Name' });
				const fileId = `local_${nextId++}`;
				objects.set(name, { fileId, bytes: body, uploadTimestamp: Date.now() });
				return json(res, 200, {
					fileName: name,
					fileId,
					contentLength: body.length,
					contentType: 'b2/x-auto',
					action: 'upload',
					uploadTimestamp: Date.now(),
				});
			}

			if (path.endsWith('/b2_list_file_names')) {
				let payload = {};
				try {
					payload = JSON.parse(body.toString('utf8') || '{}');
				} catch {
					return json(res, 400, { code: 'bad_request', message: 'bad json' });
				}
				const files = filesOf(
					String(payload.prefix ?? ''),
					typeof payload.startFileName === 'string' ? payload.startFileName : undefined,
					Number(payload.maxFileCount ?? 100),
				);
				return json(res, 200, { files, nextFileName: null });
			}

			if (path.endsWith('/b2_download_file_by_id')) {
				const fileId = query.get('fileId') ?? '';
				for (const o of objects.values()) {
					if (o.fileId === fileId) {
						res.writeHead(200, { 'content-type': 'b2/x-auto', 'content-length': String(o.bytes.length) });
						return res.end(o.bytes);
					}
				}
				return json(res, 404, { code: 'not_found', message: 'no such fileId' });
			}

			if (path.endsWith('/b2_delete_file_version')) {
				let payload = {};
				try {
					payload = JSON.parse(body.toString('utf8') || '{}');
				} catch {
					return json(res, 400, { code: 'bad_request', message: 'bad json' });
				}
				const name = String(payload.fileName ?? '');
				if (!objects.has(name)) return json(res, 404, { code: 'not_found', message: 'no such file' });
				objects.delete(name);
				return json(res, 200, { fileName: name, fileId: String(payload.fileId ?? '') });
			}

			// 直连下载：/file/<bucket>/<key>
			const directMark = '/file/';
			const at = path.indexOf(directMark);
			if (at >= 0) {
				const rest = path.slice(at + directMark.length);
				const slash = rest.indexOf('/');
				const key = slash < 0 ? '' : rest.slice(slash + 1);
				const hit = objects.get(key);
				if (hit === undefined) {
					res.writeHead(404, { 'content-type': 'application/json' });
					return res.end(JSON.stringify({ code: 'not_found', message: `no such object ${key}` }));
				}
				res.writeHead(200, { 'content-type': 'b2/x-auto', 'content-length': String(hit.bytes.length) });
				return res.end(hit.bytes);
			}

			json(res, 404, { code: 'not_found', message: `unknown path ${path}` });
		});
	});

	return new Promise((resolve) => {
		server.listen(port, '127.0.0.1', () => {
			const actual = server.address().port;
			base = `http://127.0.0.1:${actual}`;
			resolve({
				server,
				port: actual,
				base,
				bucket,
				/** 测试用：直接看当前桶里有什么 */
				names: () => [...objects.keys()].sort(),
				size: () => objects.size,
				close: () => new Promise((r) => server.close(() => r())),
			});
		});
	});
}
