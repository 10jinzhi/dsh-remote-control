/**
 * 电脑端设置接口冒烟测试（`/api/dsh-remote`）。
 *
 * 为什么要单独测：这 4 个路由是用户配置电脑端的**唯一入口** —— 它们挂了，
 * 插件就完全没法用，而 DSH 插件本身很难在本机起一个完整实例来验证。
 * 这里直接调 `createSettingsHandler()` 返回的处理函数，喂假的 req/res，
 * 后面接的是真实 B2 客户端（默认指向本地桩）。
 *
 * 覆盖：
 *   GET  /          设置页 HTML
 *   GET  /state     配置（密码打码）+ 运行时状态
 *   POST /config    保存五项（密码留空不改），触发桥重载
 *   POST /test      真跑一遍 7z 往返
 *   POST /unbind    清空通道
 *
 * 运行：node tools/settings-smoke.mjs [--real]
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { startLocalB2 } from './local-b2.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const USE_REAL = process.argv.includes('--real');
const CLOUD_FILE = `settings-${Date.now().toString(36)}`;
const LOCAL_PASSWORD = 'Local7z!test';

const results = [];
function ok(name, extra = '') {
	results.push({ name, pass: true });
	console.log(`  ✅ ${name}${extra ? `  ${extra}` : ''}`);
}
function bad(name, error) {
	results.push({ name, pass: false, error: String(error?.message ?? error) });
	console.log(`  ❌ ${name}  ${String(error?.message ?? error)}`);
}
async function check(name, fn) {
	try {
		const extra = await fn();
		ok(name, typeof extra === 'string' ? extra : '');
	} catch (error) {
		bad(name, error);
	}
}

/** 假 req：把 body 一次性推给处理函数。 */
function fakeReq(method, url, body) {
	const listeners = new Map();
	const req = {
		method,
		url,
		on(type, fn) {
			if (!listeners.has(type)) listeners.set(type, []);
			listeners.get(type).push(fn);
			if (type === 'end') {
				setImmediate(() => {
					const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')];
					for (const emit of listeners.get('data') ?? []) emit(chunks[0] ?? Buffer.alloc(0));
					for (const emit of listeners.get('end') ?? []) emit();
				});
			}
			return req;
		},
	};
	return req;
}

/** 假 res：把写出去的东西收集起来。 */
function fakeRes() {
	const res = {
		statusCode: 0,
		headers: {},
		body: '',
		writeHead(code, headers) {
			res.statusCode = code;
			res.headers = headers ?? {};
			return res;
		},
		end(chunk) {
			if (chunk !== undefined) res.body += String(chunk);
			return res;
		},
	};
	return res;
}

async function main() {
	let baseConfig;
	if (USE_REAL) {
		const home = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh');
		baseConfig = JSON.parse(readFileSync(join(home, 'dsh-remote', 'config.json'), 'utf8'));
	} else {
		baseConfig = {
			appKeyId: 'local-key-id',
			appKey: 'local-application-key',
			bucket: 'local-bucket',
			password: LOCAL_PASSWORD,
		};
	}

	// 空起步：DSH_HOME 是临时的，配置先不写，让 /state 报「缺 5 项」
	const home = mkdtempSync(join(tmpdir(), 'dsh-remote-settings-'));
	mkdirSync(join(home, 'dsh-remote'), { recursive: true });
	process.env.DSH_HOME = home;
	for (const key of [
		'DSH_REMOTE_KEY_ID', 'DSH_REMOTE_APP_KEY', 'DSH_REMOTE_BUCKET',
		'DSH_REMOTE_CLOUD_FILE', 'DSH_REMOTE_PASSWORD', 'DSH_REMOTE_B2_AUTH',
	]) {
		delete process.env[key];
	}

	let stub = null;
	if (!USE_REAL) {
		stub = await startLocalB2({ bucket: baseConfig.bucket });
		process.env.DSH_REMOTE_B2_AUTH = `${stub.base}/b2api/v3/b2_authorize_account`;
	}

	const { createSettingsHandler } = await import('../packages/dsh-remote-desktop/lib/mail7z/settings.js');
	const { loadConfig } = await import('../packages/dsh-remote-desktop/lib/mail7z/config.js');

	let reloads = 0;
	const bridge = {
		status: () => ({ running: reloads > 0, channel: loadConfig().channel?.channelId ?? '' }),
		reload: async () => { reloads += 1; return true; },
	};
	const handle = createSettingsHandler({ bridge, logger: null });

	async function http(method, path, body) {
		const res = fakeRes();
		await handle(fakeReq(method, `/api/dsh-remote${path}`, body), res);
		return res;
	}
	const asJson = (res) => {
		try {
			return JSON.parse(res.body);
		} catch {
			throw new Error(`不是 JSON（HTTP ${res.statusCode}）：${res.body.slice(0, 120)}`);
		}
	};

	console.log('== 环境 ==');
	console.log(`  后端       ${USE_REAL ? '真 Backblaze B2' : `本地桩 ${stub.base}`}`);
	console.log(`  DSH_HOME   ${home}`);
	console.log('');

	console.log('== 断言 ==');
	await check('GET / 返回设置页 HTML', async () => {
		const res = await http('GET', '');
		assert.equal(res.statusCode, 200);
		assert.match(res.headers['content-type'], /text\/html/);
		assert.ok(res.body.includes('远程控制'), '页面里没有标题');
		return `${res.body.length} 字节`;
	});

	await check('GET /state 在未配置时报出缺项、且不泄露密钥', async () => {
		const res = await http('GET', '/state');
		const body = asJson(res);
		assert.equal(res.statusCode, 200);
		assert.equal(body.missing.length, 5, `缺项数 ${body.missing.length}`);
		assert.equal(body.config.appKey, '', '还没填就有值？');
		assert.equal(body.config.passwordSet, false);
		return `缺 ${body.missing.length} 项`;
	});

	await check('POST /config 保存五项并触发一次桥重载', async () => {
		const res = await http('POST', '/config', {
			appKeyId: baseConfig.appKeyId,
			appKey: baseConfig.appKey,
			bucket: baseConfig.bucket,
			cloudFile: CLOUD_FILE,
			password: baseConfig.password,
		});
		const body = asJson(res);
		assert.equal(body.ok, true);
		assert.equal(body.missing.length, 0, `还缺：${body.missing.join('/')}`);
		assert.equal(reloads, 1, `重载次数 ${reloads}`);
		const cfg = loadConfig();
		assert.equal(cfg.cloudFile, CLOUD_FILE);
		assert.ok(cfg.channel !== null, '通道没算出来');
		return `通道 ${cfg.channel.channelId}（指纹 ${cfg.channel.fingerprint}）`;
	});

	await check('GET /state 里的密钥已打码（只留尾部）', async () => {
		const body = asJson(await http('GET', '/state'));
		assert.ok(body.config.appKeySet === true, 'key 没保存上');
		assert.ok(body.config.appKey !== baseConfig.appKey, '返回了明文 key');
		assert.ok(body.config.passwordMask.length > 0, '密码没有掩码值');
		return `appKey=${body.config.appKey}`;
	});

	await check('POST /config 里密码留空不会清掉已存的密码', async () => {
		await http('POST', '/config', { bucket: baseConfig.bucket, password: '' });
		assert.equal(loadConfig().password, baseConfig.password, '密码被清空了');
		return '密码保留';
	});

	await check('POST /test 真跑一遍 7z 往返并删掉探测对象', async () => {
		const body = asJson(await http('POST', '/test'));
		assert.equal(body.ok, true, body.message);
		assert.ok(body.ms >= 0);
		assert.ok(body.bytes > 0, '7z 包大小为 0');
		assert.equal(body.deleted, true, '探测对象没删掉');
		if (stub !== null) {
			const left = stub.names().filter((n) => n.includes('/self/'));
			assert.equal(left.length, 0, `self/ 还剩 ${left.length} 个对象`);
		}
		return `${body.ms}ms / ${body.bytes}B / 通道 ${body.channel}`;
	});

	await check('POST /unbind 清空整条通道', async () => {
		// 先塞两个假对象，确认真的会被删
		const { B2Client } = await import('../packages/dsh-remote-desktop/lib/mail7z/b2.js');
		const cfg = loadConfig();
		const client = new B2Client(cfg, () => {});
		await client.put(`${cfg.channel.root}/in/0000000000001.7z`, Buffer.from('junk'));
		await client.put(`${cfg.channel.root}/out/0000000000001.7z`, Buffer.from('junk'));

		const body = asJson(await http('POST', '/unbind'));
		assert.equal(body.ok, true, body.message);
		assert.ok(body.message.includes('2'), `清空数量不对：${body.message}`);
		const left = (await client.list(`${cfg.channel.root}/`, { maxFileCount: 10 })).length;
		assert.equal(left, 0, `还剩 ${left} 个对象`);
		return body.message;
	});

	await check('未知动作返回 404 且不崩', async () => {
		const res = await http('GET', '/nope');
		assert.equal(res.statusCode, 404);
		return asJson(res).message;
	});

	if (stub !== null) await stub.close();

	const passed = results.filter((r) => r.pass).length;
	console.log(`\n== 结果：${passed}/${results.length} 通过 ==`);
	if (passed !== results.length) {
		for (const r of results.filter((x) => !x.pass)) console.log(`  ❌ ${r.name}: ${r.error}`);
		process.exitCode = 1;
	}
}

main().catch((error) => {
	console.error('设置接口测试崩溃：', error);
	process.exit(1);
});
