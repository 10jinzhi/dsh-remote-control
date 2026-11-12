/**
 * 邮箱协议 —— 两端之间唯一的数据面。
 *
 * ```
 *   手机(APK)                                   电脑(DSH 插件)
 *   ─────────                                   ─────────────
 *   put  in/0000000000123.7z   ───────────►     pull in/  （解 7z → 处理 → 删对象）
 *   pull out/0000000000456.7z  ◄───────────     put  out/ （请求应答 / 事件批次 / 心跳）
 * ```
 *
 * ## 为什么是两条队列
 *
 * 每一步都只有**一个生产者**：手机只写 `in/`，电脑只写 `out/`。序号由生产者
 * 本地单调递增，消费者按名字升序拉取 —— 于是不需要分布式锁、不需要 CAS、
 * 不需要版本号冲突处理，B2 那个「最后写入者胜」的对象存储就够了。
 *
 * ## 一条对象里装多帧
 *
 * 一次 7z 打包 87ms（进程启动占大头），所以不做「一帧一对象」：
 * 一次轮询要把攒下的帧**合并**成一个对象。失败重试的粒度也就是一批，
 * 而每一帧自带 `id`，应用层幂等（`prompt` 带 requestId）依旧成立。
 *
 * ## 对象名就是顺序
 *
 * `in/` + 13 位十进制序号 + `.7z`。用 `startFileName` 从游标之后开始列，
 * 每次轮询恒定 1 次 Class C 调用（$0.004/万次），不会再随队列长度变贵。
 */

/** 帧格式版本；两端不一致时直接拒绝（宁可报错，不要半懂不懂地处理）。 */
export const FRAME_VERSION = 1;

const SEQ_WIDTH = 13;

export function seqName(seq) {
	return String(Math.floor(seq)).padStart(SEQ_WIDTH, '0');
}

/**
 * 生产者的下一个序号。
 *
 * 首次运行时用 `Date.now()` 起步（13 位毫秒时间戳）：这样即使手机端应用数据
 * 被清、序号从头来过，也依然**大于**上一轮的最大值 —— 消费方的游标不会因为
 * 「序号变小」而永久卡住。之后每次 +1。
 */
export function initialSeq() {
	return Date.now();
}

export class Mailbox {
	/**
	 * @param client - `B2Client`
	 * @param channel - `{ channelId, root, fingerprint }`
	 * @param password - 7z 密码
	 * @param pack - `(value, password) => Promise<Buffer>`
	 * @param unpack - `(bytes, password) => Promise<any>`
	 */
	constructor({ client, channel, password, pack, unpack, logger }) {
		this.client = client;
		this.channel = channel;
		this.password = password;
		this.pack = pack;
		this.unpack = unpack;
		this.log = logger ?? (() => {});
	}

	inPrefix() { return `${this.channel.root}/in/`; }
	outPrefix() { return `${this.channel.root}/out/`; }
	inKey(seq) { return `${this.inPrefix()}${seqName(seq)}.7z`; }
	outKey(seq) { return `${this.outPrefix()}${seqName(seq)}.7z`; }

	/**
	 * 打包 + 上传一批帧。
	 *
	 * @param queue - `'in'`（手机写的那条）或 `'out'`（电脑写的那条）。
	 *   两端都持有同一个 `Mailbox` 类，靠这个参数决定自己站在哪一侧；
	 *   早期版本把方向写死成 `out/`，结果手机和电脑抢同一条队列（已修）。
	 * @param seq - 生产者的序号（单调递增）。
	 * @param frames - 帧数组。
	 */
	async putFrames(queue, seq, frames) {
		if (queue !== 'in' && queue !== 'out') throw new Error(`未知队列 ${queue}`);
		const bytes = await this.pack({ v: FRAME_VERSION, frames }, this.password);
		await this.client.put(queue === 'in' ? this.inKey(seq) : this.outKey(seq), bytes);
		return seq;
	}

	/**
	 * 从一条队列里把游标之后的帧全取出来（含删除）。
	 *
	 * @param queue - `'in'` 表示读手机写的那条；`'out'` 表示读电脑写的那条。
	 * @param cursor - 已消费到的序号（0 表示从头）。
	 * @param max - 一次最多处理几个对象。
	 * @returns `{ frames, cursor, failed, lastFile }`
	 */
	async take(queue, cursor, max = 8) {
		const prefix = queue === 'in' ? this.inPrefix() : this.outPrefix();
		const start = cursor > 0 ? `${prefix}${seqName(cursor + 1)}` : prefix;
		const files = await this.client.list(prefix, { startFileName: start, maxFileCount: max });
		const out = [];
		let last = cursor;
		let failed = 0;
		for (const file of files) {
			const seq = Number(file.fileName.slice(prefix.length).replace(/\.7z$/, ''));
			if (!Number.isFinite(seq)) {
				// 不是我们写的对象（同前缀下别的东西）：删掉，别让它一直占着列表位。
				await this.client.deleteVersion(file.fileName, file.fileId);
				continue;
			}
			if (seq <= cursor) continue;
			let frames = null;
			try {
				const bytes = await this.client.get(file.fileName);
				if (bytes === null) { last = Math.max(last, seq); continue; }
				const payload = await this.unpack(bytes, this.password);
				if (payload?.v !== FRAME_VERSION || !Array.isArray(payload.frames)) {
					throw new Error(`帧格式版本不符（期望 v${FRAME_VERSION}）`);
				}
				frames = payload.frames;
			} catch (error) {
				// ⚠️ 解不开时**不删对象**：密码填错、帧损坏时数据是唯一线索，
				// 删了就永久没了。游标照样前移，免得一条坏帧把整条队列堵死。
				failed += 1;
				this.log(`跳过坏帧 ${file.fileName}：${error.message}`);
				last = Math.max(last, seq);
				continue;
			}
			await this.client.deleteVersion(file.fileName, file.fileId);
			out.push(...frames.map((f) => ({ ...f, _seq: seq })));
			last = Math.max(last, seq);
		}
		return { frames: out, cursor: last, failed };
	}

	/** 清空整条通道（解绑 / 测试收尾用）。 */
	async wipe() {
		const n = await this.client.deletePrefix(`${this.channel.root}/`);
		return n;
	}
}
