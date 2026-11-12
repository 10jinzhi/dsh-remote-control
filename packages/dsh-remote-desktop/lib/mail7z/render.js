/**
 * 事件渲染 —— 把 DSH 的原始 durable 事件折成「手机能直接画的气泡」。
 *
 * ## 为什么渲染放在电脑端
 *
 * 手机端如果自己读事件流，就得懂 `assistant/chunk` / `text-chunks` /
 * `surfaceOp` / `sourceEventSeqs` 这一整套语义 —— 那正是隔壁手机插件 11000 行
 * 客户端代码在做的事。本方案的 APK 定位是「只负责连接电脑」的瘦客户端，
 * 所以：**事件在电脑端就渲染成气泡，手机只做追加**。
 *
 * 好处是三重的：APK 里没有 DSH 知识（升级 DSH 不用重装 APK）、
 * 一条事件只算一次（不占手机 CPU）、协议面小到可以人工核对。
 *
 * ## 事件形状（取自本机真实会话日志，不是猜的）
 *
 * ```
 * user/message      {seq,time,data:{content:[{type:'text',text}],source:{kind:'user'|'plugin'|...}}}
 * assistant/message {seq,time,data:{turn,step,message:{content:[{type:'text',text}|{type:'tool-call',name}]}}}
 * assistant/chunk   {seq,time,data:{turn,step,chunk:{type:'block-start'|'block-stop',index,blockType}}}
 * text-chunks       {seq0,time0,data:{turn,step,index,dt:[...],texts:[...]}}   ← 注意没有 seq
 * tool/call         {seq,time,data:{turn,step,callId,name,arguments}}
 * tool/result       {seq,time,data:{message:{content:[{type:'tool-result',content:[{type:'text',text}],isError}]}}}
 * turn/start|end    {seq,time,data:{turn}}
 * ```
 *
 * ## 为什么 `text-chunks` 没有 `seq`
 *
 * 那是「流式增量被打包」的压缩事件，只有 `seq0`（本批第一块的序号）。用它
 * 做游标会把游标钉在错误的位置，所以这里的规矩是：**游标只由带 `seq` 的
 * durable 事件推进**，`text-chunks` 只贡献显示用的增量文本。
 */

/** 从 message.content 里挑出纯文本（工具调用/工具结果不算正文）。 */
export function textOf(content) {
	if (typeof content === 'string') return content;
	if (!Array.isArray(content)) return '';
	const parts = [];
	for (const part of content) {
		if (part === null || typeof part !== 'object') continue;
		if (part.type === 'text' && typeof part.text === 'string') parts.push(part.text);
	}
	return parts.join('');
}

/** 工具调用名列表（正文之外给用户看的「它干了什么」）。 */
function toolNames(content) {
	if (!Array.isArray(content)) return [];
	const out = [];
	for (const part of content) {
		if (part?.type === 'tool-call' && typeof part.name === 'string') out.push(part.name);
	}
	return out;
}

/**
 * 一条事件 → 若干「条目」。
 *
 * 条目是渲染后的最小单元，直接进 APK 的列表：
 *   `{op:'add', role, text, seq, tools?}`  追加一个气泡
 *   `{op:'live', turn, step, text}`        流式增量（手机把它拼到当前气泡）
 *   `{op:'live-reset', turn, step}`        当前流式块收了（手机的临时气泡清空）
 *   `{op:'busy', busy:true|false}`         转圈状态
 *   `{op:'tool', name}`                    工具开始调用（一行灰字）
 */
export function renderEvent(event) {
	if (event === null || typeof event !== 'object') return [];
	const seq = typeof event.seq === 'number' ? event.seq : null;
	const data = event.data ?? {};

	switch (event.type) {
		case 'user/message': {
			// `source.kind === 'user'` 才是用户真发的话；其余（plugin 注入的
			// 审批策略变更、inbox 通知等）不算对话内容，丢掉免得刷屏。
			const kind = data.source?.kind;
			if (kind !== 'user') return [];
			const text = textOf(data.content).trim();
			if (text === '') return [];
			return [{ op: 'add', role: 'user', text, seq }];
		}

		case 'assistant/message': {
			const message = data.message ?? {};
			const text = textOf(message.content).trim();
			const tools = toolNames(message.content);
			// 只有工具调用、没说话的一步：给一行「用了 X」，不当气泡。
			if (text === '') {
				return tools.length > 0 ? [{ op: 'tool', name: tools.join(', '), seq }] : [];
			}
			return [{ op: 'add', role: 'assistant', text, seq, tools, turn: data.turn, step: data.step }];
		}

		case 'assistant/chunk': {
			const chunk = data.chunk ?? {};
			if (chunk.type === 'block-start' && chunk.blockType === 'text') {
				return [{ op: 'live-reset', turn: data.turn, step: data.step }];
			}
			return [];
		}

		case 'text-chunks': {
			const texts = Array.isArray(data.texts) ? data.texts : [];
			const text = texts.join('');
			if (text === '') return [];
			return [{ op: 'live', turn: data.turn, step: data.step, index: data.index, text }];
		}

		case 'tool/call': {
			const name = typeof data.name === 'string' ? data.name : '';
			return name === '' ? [] : [{ op: 'tool', name, seq }];
		}

		case 'turn/start':
			return [{ op: 'busy', busy: true }];

		case 'turn/end':
			// `reason.kind !== 'completed'` 时（取消/出错）也要告诉手机「不转了」。
			return [{ op: 'busy', busy: false }, { op: 'live-reset', turn: data.turn }];

		default:
			return [];
	}
}

/**
 * 把一页历史事件渲染成完整气泡列表（打开会话时用）。
 *
 * 与流式渲染的区别：这里**不要** `live` 增量 —— `assistant/message` 已经带了
 * 每一步的最终文本，再把 chunk 拼进去就重复了。
 */
export function renderHistory(events) {
	const out = [];
	for (const event of events) {
		for (const item of renderEvent(event)) {
			if (item.op === 'add') out.push(item);
		}
	}
	return out;
}

/** 从一页历史里取最大 seq（游标），没有事件时返回 `-1`。 */
export function maxSeqOf(events) {
	let max = -1;
	for (const event of events) {
		if (typeof event?.seq === 'number' && event.seq > max) max = event.seq;
	}
	return max;
}

/**
 * `readHistory` 的返回可能是 `{records:[{event}]}`，也可能直接是事件数组，
 * 还可能挂在 `{events:[...]}` 下 —— 三种都见过，这里统一摊平。
 */
export function eventsOf(page) {
	if (Array.isArray(page)) return page.map((r) => (r && r.event ? r.event : r)).filter(Boolean);
	const list = page?.records ?? page?.events ?? page?.entries;
	if (!Array.isArray(list)) return [];
	return list.map((r) => (r && r.event ? r.event : r)).filter(Boolean);
}
