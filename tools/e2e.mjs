/**
 * 端到端测试 —— 真实 B2 桶 + 真实 7z + 假中继 + 手机模拟器。
 *
 * 覆盖的是「换掉公网那一截之后，链路还通不通」这件事：
 *
 *   PhoneSim ──7z/B2──► MailBridge ──HTTP──► 假中继(17891)
 *            ◄──7z/B2──            ◄──SSE──┘
 *
 * 为什么用假中继而不是真 DSH：真 DSH 的 RPC 语义已经被隔壁
 * `dsh手机` 项目用真实 B2 跑过 26 项断言，稳定；这里要验证的是**新增的**
 * 传输层与渲染层，所以把中继换成可控的桩，才能断言「收到的字节长什么样」。
 *
 * 运行：node tools/e2e.mjs（需要真实 B2 凭据，见 docs 使用说明）
 */
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { startFakeRelay } from './fake-relay.mjs';
import { startLocalB2 } from './local-b2.mjs';

const RELAY_PORT = 17981;
const TOKEN = 'e2e-token-0123456789abcdef';
const CLOUD_FILE = `e2e-${Date.now().toString(36)}`;
const USE_REAL = process.argv.includes('--real');
const LOCAL_PASSWORD = 'Local7z!test';

const results = [];
function ok(name, extra = '') {
	results.push({ name, pass: true });
	console.log(`  ✅ ${name}${extra ? `  ${extra}` : ''}`);
}
function fail(name, error) {
	results.push({ name, pass: false, error: String(error?.message ?? error) });
	console.log(`  ❌ ${name}  ${String(error?.message ?? error)}`);
}
async function check(name, fn) {
	try {
		const extra = await fn();
		ok(name, typeof extra === 'string' ? extra : '');
	} catch (error) {
		fail(name, error);
	}
}

// ---------------------------------------------------------------- 手机模拟

/** 用同一套 Mailbox 反向驱动：手机写 in/、读 out/、发 ctl。 */
class PhoneSim {
	constructor(box) {
		this.box = box;
		this.outSeq = Date.now();
		this.cursor = 0;
		this.seq = 1;
		this.pending = new Map();
		this.events = [];
		this.asks = [];
	}

	async send(frames) {
		this.outSeq += 1;
		await this.box.putFrames('in', this.outSeq, frames);
	}

	async request(method, params = {}, timeoutMs = 25_000) {
		const id = `p${this.seq++}`;
		const promise = new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error(`${method} 超时`)), timeoutMs);
			this.pending.set(id, { resolve, reject, timer });
		});
		await this.send([{ kind: 'req', id, method, params }]);
		return promise;
	}

	/** 收一轮 out/ 队列，按帧类型分派。 */
	async pump() {
		const taken = await this.box.take('out', this.cursor, 10);
		this.cursor = taken.cursor;
		for (const frame of taken.frames) {
			if (frame.kind === 'res') {
				const waiter = this.pending.get(frame.id);
				if (waiter === undefined) continue;
				clearTimeout(waiter.timer);
				this.pending.delete(frame.id);
				if (frame.ok === true) waiter.resolve(frame.result);
				else waiter.reject(new Error(frame.error));
			} else if (frame.kind === 'ev') {
				this.events.push(...frame.items);
			} else if (frame.kind === 'ask') {
				this.asks.push(frame);
			}
		}
		return taken.frames.length;
	}

	async waitFor(predicate, timeoutMs = 25_000) {
		const started = Date.now();
		while (Date.now() - started < timeoutMs) {
			await this.pump();
			if (predicate()) return true;
			await new Promise((r) => setTimeout(r, 250));
		}
		return false;
	}
}

// ---------------------------------------------------------------- 主流程

async function main() {
	/*
	 * 凭据来源：
	 *   · 默认：`tools/local-b2.mjs` 本地桩，5 项随便填 —— 可反复跑，
	 *     不消耗 Backblaze 免费额度的 transaction 配额（按天计，跑几轮就没了）；
	 *   · `--real`：真机上已经配好的那份 `$DSH_HOME/dsh-remote/config.json`
	 *     （由 tools/set-credentials.mjs 写入），复制到临时 DSH_HOME 只改
	 *     `cloudFile` ⇒ 不动真机通道与游标，写脏了也只是个带时间戳的临时前缀。
	 */
	let realConfig;
	if (USE_REAL) {
		const realState = process.env.DSH_HOME && process.env.DSH_HOME.trim() !== ''
			? process.env.DSH_HOME.trim()
			: join(homedir(), '.dsh');
		const realConfigPath = join(realState, 'dsh-remote', 'config.json');
		try {
			realConfig = JSON.parse(readFileSync(realConfigPath, 'utf8'));
		} catch {
			console.error(`找不到可用凭据：${realConfigPath}`);
			console.error('先跑一次：node tools/set-credentials.mjs --from <b2-credentials.json> --password <7z密码>');
			process.exitCode = 2;
			return;
		}
	} else {
		realConfig = {
			appKeyId: 'local-key-id',
			appKey: 'local-application-key',
			bucket: 'local-bucket',
			password: LOCAL_PASSWORD,
		};
	}

	const home = mkdtempSync(join(tmpdir(), 'dsh-remote-e2e-'));
	mkdirSync(join(home, 'dsh-remote'), { recursive: true });
	writeFileSync(
		join(home, 'dsh-remote', 'config.json'),
		`${JSON.stringify({ ...realConfig, cloudFile: CLOUD_FILE, updatedAt: Date.now() }, null, 2)}\n`,
	);
	process.env.DSH_HOME = home;
	for (const key of [
		'DSH_REMOTE_CLOUD_FILE', 'DSH_REMOTE_KEY_ID', 'DSH_REMOTE_APP_KEY',
		'DSH_REMOTE_BUCKET', 'DSH_REMOTE_PASSWORD', 'DSH_REMOTE_B2_AUTH',
	]) {
		delete process.env[key];
	}

	let stub = null;
	if (!USE_REAL) {
		stub = await startLocalB2({ bucket: realConfig.bucket });
		process.env.DSH_REMOTE_B2_AUTH = `${stub.base}/b2api/v3/b2_authorize_account`;
	}

	const { loadConfig } = await import('../packages/dsh-remote-desktop/lib/mail7z/config.js');
	const { B2Client } = await import('../packages/dsh-remote-desktop/lib/mail7z/b2.js');
	const { Mailbox } = await import('../packages/dsh-remote-desktop/lib/mail7z/mailbox.js');
	const { packJson, unpackJson, sevenZipPath } = await import('../packages/dsh-remote-desktop/lib/mail7z/sevenz.js');
	const { MailBridge } = await import('../packages/dsh-remote-desktop/lib/mail7z/bridge.js');

	const loaded = loadConfig();
	assert.ok(loaded.channel !== null, '配置不完整：需要 keyId / appKey / bucket / cloudFile / password 五项');

	console.log('== 环境 ==');
	console.log(`  后端       ${USE_REAL ? '真 Backblaze B2' : `本地桩 ${stub.base}`}`);
	console.log(`  DSH_HOME   ${home}`);
	console.log(`  7z         ${sevenZipPath()}`);
	console.log(`  bucket     ${loaded.bucket}`);
	console.log(`  通道       ${loaded.channel.channelId}（指纹 ${loaded.channel.fingerprint}）`);
	console.log(`  前缀       ${loaded.channel.root}/`);

	const relay = await startFakeRelay({ port: RELAY_PORT, token: TOKEN });
	console.log(`  假中继     http://127.0.0.1:${RELAY_PORT}`);

	const client = new B2Client(loaded);
	const box = new Mailbox({
		client, channel: loaded.channel, password: loaded.password, pack: packJson, unpack: unpackJson,
		// 干净起步：先清掉这条测试通道（名字带时间戳，只可能是上一次没跑完的）
	});
	await box.wipe();

	const bridge = new MailBridge({ relayToken: TOKEN, relayPort: RELAY_PORT, logger: null });
	bridge.configMtime = 0;
	await bridge.reload();
	bridge.start();

	const phone = new PhoneSim(box);
	const pumpTimer = setInterval(() => { phone.pump().catch(() => {}); }, 300);

	console.log('\n== 断言 ==');
	let summary = {};

	try {
		await check('7z 往返（Node 打包 → Node 解包）', async () => {
			const buf = await packJson({ v: 1, frames: [{ hello: '世界' }] }, loaded.password);
			const back = await unpackJson(buf, loaded.password);
			assert.equal(back.frames[0].hello, '世界');
			assert.equal(buf.subarray(0, 6).toString('hex'), '377abcaf271c');
			return `${buf.length}B`;
		});

		await check('错误密码被明确拒绝', async () => {
			const buf = await packJson({ v: 1, frames: [] }, loaded.password);
			await assert.rejects(() => unpackJson(buf, 'definitely-wrong'), /密码不对/);
		});

		await check('app/hello（手机 → 电脑 → 手机）', async () => {
			const hello = await phone.request('app/hello');
			assert.equal(hello.ok, true);
			assert.ok(typeof hello.host === 'string' && hello.host.length > 0);
			assert.equal(hello.fingerprint, loaded.channel.fingerprint);
			return `host=${hello.host}`;
		});

		await check('app/ping 透传到中继', async () => {
			const pong = await phone.request('app/ping');
			assert.equal(pong.ok, true);
			return `platform=${pong.platform}`;
		});

		await check('app/threads 返回工作区与对话', async () => {
			const list = await phone.request('app/threads');
			assert.equal(list.workspaces.length, 1);
			assert.equal(list.workspaces[0].sessions[0].id, 'session-fake-1');
			assert.equal(list.workspaces[0].sessions[0].pinned, true);
			return `1 个工作区 / ${list.workspaces[0].sessions.length} 个对话`;
		});

		await check('app/thread 渲染历史气泡（含工具名归并）', async () => {
			const thread = await phone.request('app/thread', { sessionId: 'session-fake-1' });
			assert.equal(thread.bubbles.length, 2, `气泡数 ${thread.bubbles.length}`);
			assert.equal(thread.bubbles[0].role, 'user');
			assert.equal(thread.bubbles[0].text, '电脑上的第一条问题');
			assert.equal(thread.bubbles[1].role, 'assistant');
			assert.match(thread.bubbles[1].text, /渲染好的回答/);
			assert.deepEqual(thread.bubbles[1].tools, ['pwsh']);
			assert.equal(thread.cursor, 3);
			assert.equal(thread.title, '假对话标题');
			return `cursor=${thread.cursor}`;
		});

		await check('app/send 透传到中继 prompt', async () => {
			const sent = await phone.request('app/send', { sessionId: 'session-fake-1', text: '你好，电脑' });
			assert.equal(sent.accepted, true);
			assert.ok(typeof sent.requestId === 'string' && sent.requestId.startsWith('app-'));
			return `requestId=${sent.requestId.slice(0, 12)}…`;
		});

		await check('未订阅前收不到事件', async () => {
			await phone.pump();
			assert.equal(phone.events.length, 0);
		});

		await check('订阅后收到渲染好的流式事件', async () => {
			await phone.send([{ kind: 'ctl', type: 'sub', sessionId: 'session-fake-1', fromSeq: -1 }]);
			const got = await phone.waitFor(() => phone.events.some((i) => i.op === 'add' && i.role === 'assistant'));
			assert.ok(got, '没收到 assistant 气泡');
			const live = phone.events.find((i) => i.op === 'live');
			assert.ok(live !== undefined, '没收到 live 增量');
			assert.equal(live.text, '流式增量');
			const hasUser = phone.events.some((i) => i.op === 'add' && i.role === 'user');
			assert.ok(hasUser, '没收到 user 气泡');
			return `${phone.events.length} 条条目`;
		});

		await check('审批弹窗（全局 SSE → ask 帧）', async () => {
			const got = await phone.waitFor(() => phone.asks.length > 0);
			assert.ok(got, '没收到 ask');
			assert.equal(phone.asks[0].requestId, 'ask-1');
			assert.equal(phone.asks[0].askKind, 'approval');
			return `requestId=${phone.asks[0].requestId}`;
		});

		await check('app/answer 回传审批结果', async () => {
			// 假中继把 answerAsk 原样接住并回话，验证的是「桥把参数送到位了」
			const answered = await phone.request('app/answer', { requestId: 'ask-1', answer: 'allowed-once' });
			assert.equal(answered.ok, true);
			assert.equal(answered.outcome, 'allowed-once');
			return `outcome=${answered.outcome}`;
		});

		await check('错误密码的对象不会堵死队列', async () => {
			// 手工塞一个用别的密码打的包
			const bad = await packJson({ v: 1, frames: [{ kind: 'req', id: 'x', method: 'app/ping' }] }, 'wrong-password');
			phone.outSeq += 1;
			await client.put(box.inKey(phone.outSeq - 1), bad);
			await phone.request('app/ping').then(() => true).catch(() => true);
			// 再发一条正常请求，必须还能通
			const pong = await phone.request('app/ping');
			assert.equal(pong.ok, true);
			return '坏帧已跳过，队列继续';
		});

		await check('心跳（电脑 → 手机）', async () => {
			bridge.lastHbAt = 0;
			const got = await phone.waitFor(() => bridge.stats.outFrames > 0);
			assert.ok(got);
			return `out ${bridge.stats.outFrames} 帧`;
		});
	} finally {
		clearInterval(pumpTimer);
		console.log('\n== 清理 ==');
		bridge.stop();
		relay.close();
		summary = { wipe: 0 };
		try {
			summary.wipe = await box.wipe();
		} catch (error) {
			console.log(`  ⚠️ 清理失败：${error.message}`);
		}
		console.log(`  已删除桶内对象 ${summary.wipe} 个`);
		await stub?.close();
	}

	const passed = results.filter((r) => r.pass).length;
	console.log(`\n== 结果：${passed}/${results.length} 通过 ==`);
	if (passed !== results.length) {
		for (const r of results.filter((x) => !x.pass)) console.log(`  ❌ ${r.name}: ${r.error}`);
		process.exitCode = 1;
	}
}

main().catch((error) => {
	console.error('E2E 崩溃：', error);
	// 假中继/本地桩可能还占着端口，不 exit 进程会挂住
	process.exit(1);
});
