/**
 * 手机端会调用的「薄 API」—— 电脑端本地实现，转发给中继，顺带做渲染。
 *
 * 手机只说 `app/xxx`：

 *   app/hello    连上后的第一条：确认对面是谁
 *   app/ping     连通性（也顺带拿 dirty 标记）
 *   app/threads  工作区 + 未归档对话列表
 *   app/thread   打开一个对话：渲染好的气泡 + 游标
 *   app/send     发一条消息
 *   app/cancel   打断当前这一轮
 *   app/pending  还有哪些审批在等我
 *   app/answer   回答一条审批
 *   app/newthread 在某个工作区开新对话
 *
 * 其余方法名**原样转发**给中继（`handleRpc` 那 20 多个方法），
 * 这样 APK 不用跟着电脑端升级，也能用 `raw` 通道临时调任何能力。
 */
import { eventsOf, maxSeqOf, renderHistory } from './render.js';

export function createApi({ relayRpc, hostInfo, logger }) {
	const log = logger ?? (() => {});

	/** 转发到中继，取出 `result`；失败时抛一条能看懂的错误。 */
	async function relay(method, params) {
		const res = await relayRpc({ id: `desk-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`, method, params });
		if (res.status !== 200) throw new Error(`中继 HTTP ${res.status}：${res.body.slice(0, 200)}`);
		let body;
		try {
			body = JSON.parse(res.body);
		} catch {
			throw new Error(`中继返回的不是 JSON：${res.body.slice(0, 200)}`);
		}
		if (body.ok !== true) throw new Error(typeof body.error === 'string' ? body.error : '中继调用失败');
		return body.result;
	}

	const handlers = {
		async 'app/hello'() {
			return { ...(await hostInfo()), ok: true };
		},

		async 'app/ping'() {
			return relay('ping', {});
		},

		async 'app/threads'(params) {
			const limit = Number.isFinite(Number(params?.limit)) ? Math.max(1, Math.min(200, Number(params.limit))) : 50;
			const result = await relay('listWorkspaces', { limit });
			const workspaces = Array.isArray(result?.workspaces) ? result.workspaces : [];
			return {
				workspaces: workspaces.map((w) => ({
					id: String(w.workspaceId ?? w.path ?? ''),
					path: String(w.path ?? ''),
					title: String(w.title ?? w.path ?? ''),
					sessions: (Array.isArray(w.sessions) ? w.sessions : []).map((s) => ({
						id: String(s.sessionId ?? ''),
						title: String(s.title ?? '（未命名对话）'),
						updatedAt: typeof s.updatedAt === 'number' ? s.updatedAt : 0,
						pinned: s.pinned === true,
					})),
				})),
			};
		},

		/**
		 * 打开一个对话：一页历史 + 渲染好的气泡 + 游标。
		 *
		 * `maxMessages` 默认 30 —— 手机上滑再要更多时带 `beforeSeq` 回来，
		 * 由中继的 `readHistory` 分页，语义与官方前端一致。
		 */
		async 'app/thread'(params) {
			const sessionId = String(params?.sessionId ?? '');
			if (sessionId === '') throw new Error('sessionId required');
			const request = { sessionId };
			if (Number.isFinite(Number(params?.maxMessages))) request.maxMessages = Number(params.maxMessages);
			if (Number.isFinite(Number(params?.beforeSeq))) request.beforeSeq = Number(params.beforeSeq);
			const page = await relay('readHistory', request);
			const events = eventsOf(page);
			const bubbles = renderHistory(events);
			let title = '';
			let usage = null;
			try {
				const projections = await relay('readProjections', { sessionId });
				const values = projections?.projections?.values ?? {};
				title = typeof values.title === 'string' ? values.title : '';
				usage = values.tokenUsage ?? null;
			} catch (error) {
				log(`读投影失败（不影响历史）：${error.message}`);
			}
			return {
				sessionId,
				title,
				usage,
				cursor: maxSeqOf(events),
				hasMore: page?.hasMore === true,
				bubbles,
			};
		},

		async 'app/send'(params) {
			const sessionId = String(params?.sessionId ?? '');
			const text = typeof params?.text === 'string' ? params.text : '';
			if (sessionId === '') throw new Error('sessionId required');
			if (text.trim() === '') throw new Error('消息不能为空');
			const requestId = typeof params?.requestId === 'string' && params.requestId !== ''
				? params.requestId
				// 幂等键：手机重发同一条（网络重试）时同一个 id，官方会去重。
				: `app-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
			const result = await relay('prompt', { sessionId, text, requestId });
			return { ...result, requestId };
		},

		async 'app/cancel'(params) {
			const sessionId = String(params?.sessionId ?? '');
			if (sessionId === '') throw new Error('sessionId required');
			return relay('cancel', { sessionId });
		},

		async 'app/pending'() {
			return relay('pendingAsks', {});
		},

		async 'app/answer'(params) {
			const requestId = String(params?.requestId ?? '');
			if (requestId === '') throw new Error('requestId required');
			return relay('answerAsk', { requestId, answer: params?.answer });
		},

		/**
		 * 在某个工作区开新对话。
		 *
		 * `sessionId` 由**手机**生成（UUID），电脑端幂等接管：手机重试不会开出
		 * 两条会话。`cwd` 必须是电脑上的绝对路径 —— 手机从 `app/threads`
		 * 拿到的工作区路径直接回传，绝不自己拼路径。
		 */
		async 'app/newthread'(params) {
			const cwd = String(params?.cwd ?? '');
			if (cwd === '') throw new Error('cwd required（用 app/threads 返回的工作区路径）');
			const sessionId = String(params?.sessionId ?? '') || `session-${crypto.randomUUID()}`;
			const created = await relay('createSession', { sessionId, cwd });
			return { sessionId: String(created?.sessionId ?? sessionId), cwd };
		},

		/** 逃生通道：手机直接指定中继方法名（排障/新功能灰度用）。 */
		async 'app/raw'(params) {
			const method = String(params?.method ?? '');
			if (method === '') throw new Error('method required');
			return relay(method, params?.params ?? {});
		},
	};

	/**
	 * 处理一条 `app/xxx`。未知方法返回 `null`，让调用方决定「转发还是报错」。
	 */
	async function handle(method, params) {
		const fn = handlers[method];
		if (typeof fn !== 'function') return null;
		return fn(params ?? {});
	}

	function methods() {
		return Object.keys(handlers);
	}

	return { handle, methods, relay };
}
