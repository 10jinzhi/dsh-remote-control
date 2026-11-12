/**
 * 假中继 —— 模拟 DSH 电脑端 `127.0.0.1:17890` 的 RPC + SSE 行为。
 *
 * 为什么用假中继而不是真 DSH：真 DSH 的 RPC 语义已经被隔壁 `dsh手机` 项目
 * 用真实 B2 跑过 26 项断言；本仓库要验证的是**新增的传输层与渲染层**，
 * 只有把中继换成可控的桩，才能断言「收到的字节长什么样」。
 *
 * 两个测试（tools/e2e.mjs 的 Node 模拟器、tools/e2e-app.mjs 的 Java 客户端）
 * 共用这一份，避免两边对协议的理解漂移。
 */
import { createServer } from 'node:http';

export const FAKE_EVENTS = [
	{ type: 'turn/start', seq: 1, time: Date.now(), data: { turn: 1 } },
	{
		type: 'user/message', seq: 2, time: Date.now(),
		data: { content: [{ type: 'text', text: '电脑上的第一条问题' }], source: { kind: 'user' }, role: 'user', id: 'u1' },
	},
	{
		type: 'assistant/message', seq: 3, time: Date.now(),
		data: {
			turn: 1, step: 1,
			message: {
				role: 'assistant',
				content: [
					{ type: 'text', text: '这是电脑端渲染好的回答。' },
					{ type: 'tool-call', id: 'c1', name: 'pwsh', arguments: '{}' },
				],
				id: 'a1',
			},
		},
	},
];

/**
 * 订阅之后「新到」的一条回答。
 *
 * 为什么单独有它：手机端订阅时带的是 `fromSeq=<打开对话时的游标>`，
 * 假中继按游标补历史会把 seq 1~3 全跳过 —— 于是订阅后只看得到流式增量，
 * 断言「收到 assistant 气泡」就无从谈起。真实电脑端订阅后总会有新事件，
 * 这里用一条 seq=11 的事件把这种情况补上。
 */
export const LIVE_ASSISTANT = {
	type: 'assistant/message',
	seq: 11,
	time: Date.now(),
	data: {
		turn: 2, step: 1,
		message: {
			role: 'assistant',
			content: [{ type: 'text', text: '订阅之后新到的一段回答。' }],
			id: 'a2',
		},
	},
};

export function startFakeRelay({ port, token }) {
	const server = createServer((req, res) => {
		const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
		if (req.headers['x-dsh-remote-control-token'] !== token) {
			res.writeHead(403, { 'content-type': 'application/json' });
			res.end(JSON.stringify({ error: 'forbidden' }));
			return;
		}
		if (url.pathname === '/api/dsh-remote-control/rpc' && req.method === 'POST') {
			const chunks = [];
			req.on('data', (c) => chunks.push(c));
			req.on('end', () => {
				const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
				const reply = (result) => {
					res.writeHead(200, { 'content-type': 'application/json' });
					res.end(JSON.stringify({ id: body.id, ok: true, result }));
				};
				switch (body.method) {
					case 'ping':
						return reply({ ok: true, platform: process.platform, dirty: [] });
					case 'listWorkspaces':
						return reply({
							workspaces: [{
								workspaceId: 'w1',
								path: 'C:\\fake\\workspace',
								title: '假工作区',
								sessions: [{ sessionId: 'session-fake-1', title: '假对话', updatedAt: Date.now(), pinned: true }],
							}],
						});
					case 'readHistory':
						return reply({ records: FAKE_EVENTS.map((event) => ({ type: 'event', event })), hasMore: false });
					case 'readProjections':
						return reply({ projections: { asOfSeq: 3, values: { title: '假对话标题' } } });
					case 'prompt':
						return reply({ sessionId: body.params?.sessionId, requestId: body.params?.requestId, accepted: true });
					case 'cancel':
						return reply({ accepted: true });
					case 'pendingAsks':
						return reply({ requests: [] });
					case 'answerAsk':
						return reply({ ok: true, outcome: 'allowed-once' });
					case 'createSession':
						return reply({ sessionId: body.params?.sessionId, cwd: body.params?.cwd });
					default:
						res.writeHead(200, { 'content-type': 'application/json' });
						res.end(JSON.stringify({ id: body.id, ok: false, error: `unknown method ${body.method}` }));
				}
			});
			return;
		}
		if (url.pathname === '/api/dsh-remote-control/stream') {
			res.writeHead(200, {
				'content-type': 'text/event-stream; charset=utf-8',
				'cache-control': 'no-store',
				connection: 'keep-alive',
			});
			const sessionId = url.searchParams.get('session');
			res.write(': connected\n\n');
			if (sessionId === null) {
				setTimeout(() => {
					res.write(`event: ask\ndata: ${JSON.stringify({
						requestId: 'ask-1', kind: 'approval', sessionId: 'session-fake-1',
						question: '允许运行 pwsh 吗？', options: ['allowed-once', 'rejected'],
					})}\n\n`);
				}, 120);
			} else {
				const fromSeq = Number(url.searchParams.get('fromSeq') ?? '-1');
				setTimeout(() => {
					for (const event of FAKE_EVENTS) {
						if (event.seq <= fromSeq) continue;
						res.write(`event: event\ndata: ${JSON.stringify(event)}\n\n`);
					}
					res.write(`event: event\ndata: ${JSON.stringify(LIVE_ASSISTANT)}\n\n`);
					res.write(`event: event\ndata: ${JSON.stringify({
						type: 'text-chunks', seq0: 10, time0: Date.now(),
						data: { turn: 2, step: 1, index: 0, dt: [1, 2], texts: ['流式', '增量'] },
					})}\n\n`);
				}, 150);
			}
			const beat = setInterval(() => {
				try { res.write(': ping\n\n'); } catch { /* 断开 */ }
			}, 5000);
			req.on('close', () => clearInterval(beat));
			return;
		}
		res.writeHead(404).end();
	});
	return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}
