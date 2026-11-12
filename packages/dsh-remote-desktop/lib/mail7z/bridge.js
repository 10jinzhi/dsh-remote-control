/**
 * 电脑端桥 —— 把「B2 上的 7z 邮箱」接到本机中继 `127.0.0.1:17890`。
 *
 * ```
 *   in/*.7z   ──7z 解密──►  app/xxx 或原样转发的 RPC  ──HTTP──►  127.0.0.1:17890
 *   out/*.7z  ◄─7z 加密──   应答 / 渲染后的气泡 / 心跳        ◄──SSE──┘
 * ```
 *
 * 中继本身（`lib/index.js`）一行都没改：它仍然只认那个本地 HTTP 服务，
 * 只是「公网那一截」从 Cloudflare 隧道换成了 Backblaze B2 上的加密 7z。
 *
 * ## 轮询节奏
 *
 * 手机在动 ⇒ 500ms 一轮；刚离开 ⇒ 1.5s；久无活动 ⇒ 4s。一次 tick 的固定成本
 * 是 2 次 Class C 列举（$0.0000008），所以慢轮询主要是为了省手机的电。
 *
 * ## 为什么事件也要过桥
 *
 * 手机看不到 SSE，所以桥会在电脑侧**代替手机订阅**中继的 SSE（`ctl sub`），
 * 把收到的 durable 事件用 `render.js` 渲染成气泡，再打包进 `out/`。
 * 一帧里可能有多条增量 —— 手机上看到的是逐段冒出来的文字，而不是一行行 JSON。
 */
import http from 'node:http';
import os from 'node:os';
import { statSync } from 'node:fs';
import { B2Client, rawRequest } from './b2.js';
import { CONFIG_PATH, STATE_DIR, loadConfig, loadState, missingFields, saveState } from './config.js';
import { Mailbox, initialSeq } from './mailbox.js';
import { packJson, unpackJson, sevenZipPath } from './sevenz.js';
import { createApi } from './api.js';
import { renderEvent } from './render.js';

const RELAY_ORIGIN = 'http://127.0.0.1:17890';
const RPC_PATH = '/api/dsh-remote/rpc';
const STREAM_PATH = '/api/dsh-remote/stream';

/** 心跳间隔 / 「手机还在」的判定窗口。 */
const HB_EVERY_MS = 30_000;
const APP_ALIVE_MS = 5 * 60_000;

/** 一次 tick 最多处理多少个对象（防止首连时一次拉几百个）。 */
const MAX_PER_TICK = 8;

/** 解析一个 SSE 块：`event: x\ndata: {...}`。 */
function parseSseBlock(block) {
	let event = 'message';
	const dataLines = [];
	for (const line of block.split('\n')) {
		if (line.startsWith('event:')) event = line.slice(6).trim();
		else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
	}
	if (dataLines.length === 0) return null;
	const data = dataLines.join('\n');
	let payload = data;
	try {
		payload = JSON.parse(data);
	} catch {
		/* 不是 JSON 就原样留着（`: ping` 之类已经在上面被过滤了） */
	}
	return { event, payload };
}

/** 一条 SSE 订阅：连中继，把块扔给回调。 */
class SseTap {
	constructor({ url, token, onBlock, onError, label }) {
		this.closed = false;
		this.req = null;
		this.label = label;
		const req = http.get(url, { headers: { accept: 'text/event-stream', 'x-dsh-remote-token': token } }, (res) => {
			if (res.statusCode !== 200) {
				onError?.(`SSE ${this.label} HTTP ${res.statusCode}`);
				res.resume();
				return;
			}
			let carry = '';
			res.setEncoding('utf8');
			res.on('data', (chunk) => {
				carry += chunk;
				let idx;
				while ((idx = carry.indexOf('\n\n')) >= 0) {
					const block = carry.slice(0, idx);
					carry = carry.slice(idx + 2);
					if (block.trim() === '' || block.trimStart().startsWith(':')) continue;
					const parsed = parseSseBlock(block);
					if (parsed !== null) onBlock(parsed);
				}
			});
			res.on('error', (e) => onError?.(`SSE ${this.label} 读错误：${e.message}`));
		});
		req.on('error', (e) => onError?.(`SSE ${this.label} 连接错误：${e.message}`));
		this.req = req;
	}

	close() {
		this.closed = true;
		try { this.req?.destroy(); } catch { /* 已关闭 */ }
	}
}

export class MailBridge {
	constructor({ relayToken, logger, relayPort = 17890 } = {}) {
		this.relayToken = relayToken;
		this.relayOrigin = `http://127.0.0.1:${relayPort}`;
		this.log = (m) => (logger?.info ? logger.info(`[dsh-remote] ${m}`) : console.log(`[dsh-remote] ${m}`));
		this.warn = (m) => (logger?.warn ? logger.warn(`[dsh-remote] ${m}`) : console.warn(`[dsh-remote] ${m}`));
		this.stopped = true;
		this.config = null;
		this.configMtime = 0;
		this.client = null;
		this.box = null;
		this.state = { outSeq: 0, inCursor: 0, lastAppSeenAt: 0 };
		this.outbox = [];
		this.taps = new Map();
		this.askTap = null;
		this.timer = null;
		this.loopPromise = null;
		this.lastHbAt = 0;
		this.lastAppSeenAt = 0;
		this.lastError = '';
		this.stats = { inFrames: 0, outFrames: 0, outObjects: 0 };
		// `app/*` 的实现（转发 + 渲染）。放在构造里而不是 start() 之后，
		// 否则第一轮 tick 有可能在 api 还没装上时收到请求。
		this.api = createApi({
			relayRpc: (request) => this.relayRpc(request),
			hostInfo: async () => ({
				host: os.hostname(),
				platform: process.platform,
				node: process.version,
				version: VERSION,
				channel: this.config?.channel?.channelId ?? '',
				fingerprint: this.config?.channel?.fingerprint ?? '',
			}),
			logger: (m) => this.log(m),
		});
	}

	/** 是否已具备运行条件（5 项配置齐全）。 */
	ready() {
		return this.box !== null;
	}

	status() {
		const cfg = this.config ?? loadConfig();
		return {
			running: this.ready() && !this.stopped,
			channel: cfg.channel?.channelId ?? '',
			fingerprint: cfg.channel?.fingerprint ?? '',
			root: cfg.channel?.root ?? '',
			bucket: cfg.bucket ?? '',
			cloudFile: cfg.cloudFile ?? '',
			hasPassword: typeof cfg.password === 'string' && cfg.password !== '',
			lastAppSeenAt: this.lastAppSeenAt,
			lastError: this.lastError,
			sevenZip: (() => { try { return sevenZipPath(); } catch (error) { return `缺失：${error.message}`; } })(),
			stats: { ...this.stats },
			statePath: STATE_DIR,
		};
	}

	/**
	 * 装载配置并建好 B2 客户端。
	 *
	 * 配置不全时**不抛错**：装完插件、还没在设置页填那 5 项是正常状态，
	 * 抛错会让整个 DSH 起不来。这里只记一条提示，等用户填完（配置文件
	 * mtime 变化）再自动接上。
	 */
	async reload() {
		const cfg = loadConfig();
		/*
		 * 记下这次装载时配置文件的 mtime。
		 *
		 * 不记的话 `maybeReloadByMtime()` 会在第一轮 tick 里把 0 和真实 mtime
		 * 比一次，认为「刚改过」→ 立刻再 reload 一遍：多一次 B2 授权、多一次
		 * 对象列举，日志里还会出现两条一模一样的「已装载通道」。
		 */
		try { this.configMtime = statSync(CONFIG_PATH).mtimeMs; } catch { this.configMtime = 0; }
		this.config = cfg;
		const missing = missingFields(cfg);
		if (missing.length > 0) {
			this.box = null;
			this.client = null;
			this.lastError = `配置未填：${missing.join(' / ')}`;
			this.log(`尚未配对（缺 ${missing.join('、')}），请到「设置 → 远程控制」里填写`);
			return false;
		}
		try { resolve7zQuiet(); } catch (error) {
			this.box = null;
			this.lastError = error.message;
			this.warn(error.message);
			return false;
		}
		this.client = new B2Client({ appKeyId: cfg.appKeyId, appKey: cfg.appKey, bucket: cfg.bucket }, (m) => this.log(m));
		this.box = new Mailbox({
			client: this.client,
			channel: cfg.channel,
			password: cfg.password,
			pack: packJson,
			unpack: unpackJson,
			logger: (m) => this.warn(m),
		});
		this.state = loadState();
		if (!Number.isFinite(this.state.outSeq) || this.state.outSeq <= 0) this.state.outSeq = initialSeq();
		this.lastAppSeenAt = Number(this.state.lastAppSeenAt ?? 0);
		this.lastError = '';
		this.log(`已装载通道 ${cfg.channel.channelId}（指纹 ${cfg.channel.fingerprint}），桶 ${cfg.bucket}，前缀 ${cfg.channel.root}/`);
		return true;
	}

	/** 起循环（幂等）。 */
	start() {
		if (this.loopPromise !== null) return this;
		this.stopped = false;
		this.loopPromise = this.loop();
		return this;
	}

	stop() {
		this.stopped = true;
		if (this.timer) clearTimeout(this.timer);
		for (const tap of this.taps.values()) tap.close();
		this.taps.clear();
		this.askTap?.close();
		this.askTap = null;
		this.loopPromise = null;
		this.log('桥已停止');
	}

	/** 配置文件变了就重载（用户在设置页点保存后自动生效，不用重启 DSH）。 */
	maybeReloadByMtime() {
		let mtime = 0;
		try { mtime = statSync(CONFIG_PATH).mtimeMs; } catch { mtime = 0; }
		if (mtime === 0 || mtime === this.configMtime) return false;
		this.configMtime = mtime;
		void this.reload();
		return true;
	}

	// ------------------------------------------------------------ 出站

	/** 往 out/ 塞一帧（不立刻上传，等 tick 末尾合并上传）。 */
	push(frame) {
		this.outbox.push(frame);
	}

	/** 把攒下的帧合并成**一个** 7z 对象上传。 */
	async flushOut() {
		if (this.outbox.length === 0 || this.box === null) return;
		const frames = this.outbox;
		this.outbox = [];
		const seq = this.state.outSeq + 1;
		try {
			await this.box.putFrames('out', seq, frames);
			this.state.outSeq = seq;
			saveState({ ...this.state, lastAppSeenAt: this.lastAppSeenAt });
			this.stats.outObjects += 1;
			this.stats.outFrames += frames.length;
		} catch (error) {
			// 上传失败：把帧放回队首，下一轮重试（顺序不能乱）。
			this.outbox = [...frames, ...this.outbox];
			this.lastError = `上传失败：${error.message}`;
			this.warn(this.lastError);
		}
	}

	// ------------------------------------------------------------ 入站

	async tick() {
		if (this.box === null) return;

		// ① 收手机写来的帧
		const taken = await this.box.take('in', this.state.inCursor, MAX_PER_TICK);
		if (taken.failed > 0) {
			this.warn(`${taken.failed} 个对象解不开（密码不一致？），已跳过但**未删除**，可在桶里人工取回`);
		}
		if (taken.cursor !== this.state.inCursor) {
			this.state.inCursor = taken.cursor;
			saveState({ ...this.state, lastAppSeenAt: this.lastAppSeenAt });
		}
		for (const frame of taken.frames) {
			this.stats.inFrames += 1;
			this.lastAppSeenAt = Date.now();
			this.state.lastAppSeenAt = this.lastAppSeenAt;
			await this.handleFrame(frame);
		}

		// ② 事件批次尾巴：把 tap 里还没发出去的攒批刷掉
		for (const tap of this.taps.values()) tap.flushIfDue();

		// ③ 心跳
		const now = Date.now();
		if (now - this.lastHbAt >= HB_EVERY_MS && now - this.lastAppSeenAt < APP_ALIVE_MS) {
			this.lastHbAt = now;
			this.push({
				kind: 'hb',
				role: 'desk',
				at: now,
				host: os.hostname(),
				platform: process.platform,
				version: VERSION,
			});
		}

		// ④ 上传
		await this.flushOut();
	}

	async handleFrame(frame) {
		if (frame === null || typeof frame !== 'object') return;
		switch (frame.kind) {
			case 'hb':
				// 手机心跳：只用来点亮「手机在线」，不产生任何回包。
				return;

			case 'ctl': {
				if (frame.type === 'sub') {
					this.subscribe(String(frame.sessionId ?? ''), Number(frame.fromSeq ?? -1));
				} else if (frame.type === 'unsub') {
					const id = String(frame.sessionId ?? '');
					const tap = this.taps.get(id);
					if (tap) { tap.close(); this.taps.delete(id); this.log(`取消订阅 ${id}`); }
				}
				return;
			}

			case 'req': {
				const id = String(frame.id ?? '');
				if (id === '') return;
				const method = String(frame.method ?? '');
				const params = frame.params ?? {};
				try {
					const local = await this.api.handle(method, params);
					if (local !== null) {
						this.push({ kind: 'res', id, ok: true, result: local });
						return;
					}
					// 不是 app/* ⇒ 原样转发给中继（handleRpc 的 20 多个方法）
					const res = await this.relayRpc({ id, method, params });
					if (res.status !== 200) {
						this.push({ kind: 'res', id, ok: false, error: `中继 HTTP ${res.status}` });
						return;
					}
					const body = JSON.parse(res.body);
					this.push(body.ok === true
						? { kind: 'res', id, ok: true, result: body.result }
						: { kind: 'res', id, ok: false, error: String(body.error ?? '中继调用失败') });
				} catch (error) {
					this.push({ kind: 'res', id, ok: false, error: String(error?.message ?? error) });
				}
				return;
			}

			default:
				return;
		}
	}

	/** 订阅一个会话的实时事件；同一个会话重复订阅只保留一条。 */
	subscribe(sessionId, fromSeq) {
		if (sessionId === '') return;
		if (this.taps.has(sessionId)) return;
		const url = new URL(`${this.relayOrigin}${STREAM_PATH}`);
		url.searchParams.set('session', sessionId);
		url.searchParams.set('fromSeq', String(Number.isFinite(fromSeq) ? fromSeq : -1));
		const tap = new StreamTap({
			url,
			token: this.relayToken,
			sessionId,
			onFrame: (frame) => this.push(frame),
			onError: (m) => this.warn(m),
			log: (m) => this.log(m),
		});
		this.taps.set(sessionId, tap);
		this.log(`订阅会话 ${sessionId}（fromSeq=${fromSeq}）`);
	}

	/** 订阅中继的全局 SSE（审批弹窗走这条，与用户在看哪个会话无关）。 */
	ensureAskTap() {
		if (this.askTap !== null || this.stopped) return;
		this.askTap = new SseTap({
			url: new URL(`${this.relayOrigin}${STREAM_PATH}`),
			token: this.relayToken,
			label: 'ask',
			onBlock: ({ event, payload }) => {
				if (event !== 'ask' && event !== 'approval' && event !== 'event') return;
				const p = payload ?? {};
				// 中继推的 `ask` 事件形状：{requestId, kind, sessionId, payload}
				const requestId = String(p.requestId ?? p.id ?? '');
				if (requestId === '') return;
				this.push({
					kind: 'ask',
					requestId,
					askKind: String(p.kind ?? 'ask'),
					sessionId: String(p.sessionId ?? ''),
					payload: p.payload ?? p,
					at: Date.now(),
				});
			},
			onError: (m) => this.warn(m),
		});
	}

	// ------------------------------------------------------------ 中继

	relayRpc(request) {
		return rawRequest(`${this.relayOrigin}${RPC_PATH}`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', 'x-dsh-remote-token': this.relayToken },
			body: Buffer.from(JSON.stringify(request)),
			timeout: 60_000,
		}).then(
			(res) => ({ status: res.status, body: res.body.toString('utf8') }),
			(error) => ({ status: 502, body: JSON.stringify({ ok: false, error: `本地中继不可用：${error.message}` }) }),
		);
	}

	// ------------------------------------------------------------ 循环

	delay() {
		const idle = Date.now() - this.lastAppSeenAt;
		if (this.taps.size > 0) return 500;
		if (idle < 60_000) return 500;
		if (idle < 10 * 60_000) return 1500;
		return 4000;
	}

	async loop() {
		// 首次装载：没配对就等着，配对好了（mtime 变了）自动接上。
		await this.reload();
		this.ensureAskTap();
		while (!this.stopped) {
			try {
				this.maybeReloadByMtime();
				await this.tick();
			} catch (error) {
				this.lastError = error.message;
				this.warn(`轮询出错：${error.message}`);
				await new Promise((r) => setTimeout(r, 2000));
			}
			if (this.stopped) break;
			const wait = this.ready() ? this.delay() : 3000;
			await new Promise((r) => {
				this.timer = setTimeout(r, wait);
				this.timer.unref?.();
			});
		}
	}
}

/** 版本号（与 package.json 对齐，写在日志/心跳里便于对账）。 */
const VERSION = '1.0.52-remote.1';

/**
 * 单个会话的事件订阅：把 SSE 帧渲染成气泡，攒批后交给桥。
 *
 * 攒批是必须的：逐字流式一秒能来几十帧，一帧一个 B2 对象既慢又贵。
 * 这里按「400ms 或 8KB」两个阈值刷一次，手机上看到的就是**一段一段**冒字。
 */
class StreamTap {
	constructor({ url, token, sessionId, onFrame, onError, log }) {
		this.sessionId = sessionId;
		this.onFrame = onFrame;
		this.log = log;
		this.items = [];
		this.bytes = 0;
		this.lastFlush = Date.now();
		this.live = null;
		this.sse = new SseTap({
			url, token, label: `session ${sessionId}`,
			onBlock: ({ event, payload }) => this.accept(event, payload),
			onError,
		});
	}

	accept(event, payload) {
		if (event !== 'event' && event !== 'frame') return;
		// `frame:` 是流式帧（老版本兼容），`event:` 是 durable 事件。
		if (event === 'frame') {
			if (payload?.type === 'chunk' && typeof payload.chunk === 'string') {
				this.items.push({ op: 'live', turn: payload.turn, step: payload.step, text: payload.chunk });
				this.bytes += payload.chunk.length;
			}
			this.flushIfDue();
			return;
		}
		for (const item of renderEvent(payload)) {
			this.items.push(item);
			this.bytes += typeof item.text === 'string' ? item.text.length : 16;
		}
		this.flushIfDue();
	}

	/** 到时间/到量就打包成一帧 `ev` 推给手机。 */
	flushIfDue(force = false) {
		if (this.items.length === 0) return;
		const due = force
			|| Date.now() - this.lastFlush >= 400
			|| this.bytes >= 8192;
		if (!due) return;
		const items = this.items;
		this.items = [];
		this.bytes = 0;
		this.lastFlush = Date.now();
		this.onFrame({ kind: 'ev', sessionId: this.sessionId, items });
	}

	close() { this.sse.close(); }
}

function resolve7zQuiet() {
	// 提前探一次，缺 7z 时在设置页就能看到原因，而不是等第一条消息才报错。
	sevenZipPath();
}

/** 插件入口用的工厂。 */
export function startMailBridge({ relayToken, logger, relayPort }) {
	const bridge = new MailBridge({ relayToken, logger, relayPort });
	bridge.start();
	return bridge;
}

export { VERSION };
