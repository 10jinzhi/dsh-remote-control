/**
 * 邮箱协议 —— 两端之间唯一的数据面。
 *
 * ```
 *   手机(APK)                                         电脑(DSH 插件)
 *   ─────────                                         ─────────────
 *   put  from-phone/0000000000123.7z    ───────────►  pull from-phone/（解 7z → 处理 → 删对象）
 *   pull from-desktop/0000000000456.7z  ◄───────────  put  from-desktop/（应答 / 事件批次 / 心跳）
 * ```
 *
 * 完整对象名（以电脑端为例，B2 是扁平存储，斜杠只是名字的一部分）：
 *
 * ```
 *   dsh-remote/v2/<云端文件名>/ch/<12位通道哈希>/from-phone/0001794483231981.7z
 *   └── 软件隔离 ┘└─ 哪台电脑 ─┘└─ 哪条通道 ──┘└ 谁写的 ┘└──── 顺序 ────┘
 * ```
 *
 * ## 为什么目录名要写「谁写的」
 *
 * 早期用的是 `in/` `out/`：站在电脑角度（in = 进电脑）。问题是两端共用这一份
 * 代码/同一个类，手机端看到同一对词得把语义翻过来，读的人十次有三次搞反；
 * 而且 `in` `out` 太通用，翻桶时完全看不出是哪个软件、哪个方向。
 * 换成 `from-phone` / `from-desktop` 后，方向由**生产者**命名，不依赖视角。
 *
 * ## 为什么是两条队列
 *
 * 每一步都只有**一个生产者**：手机只写 `from-phone/`，电脑只写 `from-desktop/`。
 * 序号由生产者本地单调递增，消费者按名字升序拉取 —— 于是不需要分布式锁、
 * 不需要 CAS、不需要版本号冲突处理，B2 那个「最后写入者胜」的对象存储就够了。
 *
 * ## 一条对象里装多帧
 *
 * 一次 7z 打包 87ms（进程启动占大头），所以不做「一帧一对象」：
 * 一次轮询要把攒下的帧**合并**成一个对象。失败重试的粒度也就是一批，
 * 而每一帧自带 `id`，应用层幂等（`prompt` 带 requestId）依旧成立。
 *
 * ## 对象名就是顺序
 *
 * `from-phone/` + 13 位十进制序号 + `.7z`。用 `startFileName` 从游标之后开始列，
 * 每次轮询恒定 1 次 Class C 调用（$0.004/万次），不会再随队列长度变贵。
 */

/** 帧格式版本；两端不一致时直接拒绝（宁可报错，不要半懂不懂地处理）。 */
export const FRAME_VERSION = 1;

const SEQ_WIDTH = 13;

/**
 * 队列名（= 目录名）。键是代码里用的短标识，值是桶里的真实目录。
 *
 * 手机端 `Mailbox.java` 里有一份逐字相同的表 —— 改这里必须同步改那边，
 * 否则两端各写各的目录，表现为「发出去没回音」。
 */
export const QUEUE_DIR = {
	/** 手机写、电脑读。 */
	phone: 'from-phone',
	/** 电脑写、手机读。 */
	desktop: 'from-desktop',
};

function queueDir(queue) {
	const dir = QUEUE_DIR[queue];
	if (!dir) throw new Error(`未知队列 ${queue}`);
	return dir;
}

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

	/** @param queue - `'phone'` 或 `'desktop'` */
	prefix(queue) {
		return `${this.channel.root}/${queueDir(queue)}/`;
	}

	key(queue, seq) {
		return `${this.prefix(queue)}${seqName(seq)}.7z`;
	}

	/**
	 * 打包 + 上传一批帧。
	 *
	 * @param queue - `'phone'`（手机写的那条）或 `'desktop'`（电脑写的那条）。
	 *   两端都持有同一个 `Mailbox` 类，靠这个参数决定自己站在哪一侧；
	 *   早期版本把方向写死成一条队列，结果手机和电脑抢同一条（已修）。
	 * @param seq - 生产者的序号（单调递增）。
	 * @param frames - 帧数组。
	 */
	async putFrames(queue, seq, frames) {
		const bytes = await this.pack({ v: FRAME_VERSION, frames }, this.password);
		await this.client.put(this.key(queue, seq), bytes);
		return seq;
	}

	/**
	 * 从一条队列里把游标之后的帧全取出来（含删除）。
	 *
	 * @param queue - `'phone'` 读手机写的；`'desktop'` 读电脑写的。
	 * @param cursor - 已消费到的序号（0 表示从头）。
	 * @param max - 一次最多处理几个对象。
	 * @returns `{ frames, cursor, failed, lastFile }`
	 */
	async take(queue, cursor, max = 8) {
		const prefix = this.prefix(queue);
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
