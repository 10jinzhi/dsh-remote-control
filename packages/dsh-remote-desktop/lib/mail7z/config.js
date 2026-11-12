/**
 * 配对配置 —— 与手机端「设置」面板里要填的 5 项完全对应。
 *
 *   Application Key ID   appKeyId
 *   Application Key      appKey
 *   Bucket 名称           bucket
 *   云端文件名            cloudFile
 *   加密密码（本方案新增）  password
 *
 * 前三项是 Backblaze B2 的凭据（限定 bucket、Read and Write 权限即可，**不要**
 * 用 Master Application Key），`cloudFile` 决定桶里用哪个目录做「邮箱」，
 * `password` 是每个 7z 包的加密密码。
 *
 * ⚠️ 这 5 项都**只存本机**：电脑端落在 `$DSH_HOME/dsh-remote/config.json`
 * （0600），手机端落在应用私有目录里，两端都不进任何仓库。
 *
 * 通道 ID 由 `bucket + cloudFile + appKey` 确定性派生，所以两端填同样的 5 项
 * 就是同一条通道 —— 没有配对码、没有二维码、没有过期时间。
 */
import { createHash, createHmac } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** `$DSH_HOME` —— 空串/纯空白视为未设置（与 DSH 其它插件同语义）。 */
export function dshHome() {
	const raw = typeof process.env.DSH_HOME === 'string' ? process.env.DSH_HOME.trim() : '';
	return raw === '' ? join(homedir(), '.dsh') : raw;
}

export const STATE_DIR = join(dshHome(), 'dsh-remote');
export const CONFIG_PATH = join(STATE_DIR, 'config.json');
export const STATE_PATH = join(STATE_DIR, 'state.json');

/**
 * 邮箱根目录前缀。改动它等于让两端一起换地址（版本升级时用）。
 *
 * v2 起队列目录改成 `from-phone/` `from-desktop/`：早期用 `in/` `out/`，
 * 那对词是站电脑视角取的（in = 进电脑），手机端读同一份代码得反过来理解，
 * 而且 `in` `out` 太通用，人翻桶看不出方向。升版本号而不是原地改名，
 * 是为了让旧结构彻底不被新代码扫到 —— 这版还没对外使用，干净切换比兼容划算。
 */
const ROOT = 'dsh-remote/v2';

/** 云端文件名只允许这几类字符，其余一律换成 `_`（B2 对象名不能随便来）。 */
export function sanitizeName(value) {
	const raw = String(value ?? '').trim().replace(/^\/+|\/+$/g, '');
	if (raw === '') return '';
	return raw.replace(/[^\w.\-]+/g, '_').slice(0, 120);
}

/**
 * 把「机器名」转成可以直接当云端文件名用的短名（与手机端 `Config.defaultCloudFile` 逐字一致）。
 *
 * 通道 ID 由 `appKey + bucket + cloudFile` 派生成，所以这一项就是「哪台电脑」：
 * 它不同 ⇒ 通道不同 ⇒ 另一台机器的独立邮箱。
 *
 * 规则：
 *   · 转小写、非 `[a-z0-9]` 一律折成 `-`、去掉首尾与重复的 `-`、最长 40；
 *   · 全部被折光时（中文机器名）退化成 `desk-<sha256 前 6 位>`。
 *
 * 中文名不直接保留：两端清洗分别跑在 Java 与 JS 上，Unicode 归一化 / 大小写
 * 折叠的任何一点差异都会让同一台机器算出两条通道，而这种错几乎无法从现象上
 * 归因。宁可退化成一个明显的自动生成名，让用户自己改成好记的短名。
 */
export function defaultCloudFile(name) {
	const raw = String(name ?? '').trim().toLowerCase();
	let slug = raw.replace(/[^a-z0-9]+/g, '-').replace(/^-+/, '').replace(/-+$/, '');
	if (slug.length > 40) slug = slug.slice(0, 40).replace(/-+$/, '');
	if (slug === '') slug = `desk-${createHash('sha256').update(raw).digest('hex').slice(0, 6)}`;
	return slug;
}

/** 5 项配置是否齐全。返回缺失的字段名数组，空数组表示齐全。 */
export function missingFields(cfg) {
	const out = [];
	if (!str(cfg?.appKeyId)) out.push('appKeyId');
	if (!str(cfg?.appKey)) out.push('appKey');
	if (!str(cfg?.bucket)) out.push('bucket');
	if (!sanitizeName(cfg?.cloudFile)) out.push('cloudFile');
	if (!str(cfg?.password)) out.push('password');
	return out;
}

function str(v) { return typeof v === 'string' ? v.trim() : ''; }

/**
 * 读配置。优先级：环境变量 > 配置文件。
 *
 * 电脑端这样排是因为：装进 DSH 后用户是**在界面里填**（写配置文件），
 * 而排障时可以临时用环境变量覆盖，不用改用户已保存的那份。
 */
export function loadConfig() {
	let file = {};
	if (existsSync(CONFIG_PATH)) {
		try {
			file = JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) ?? {};
		} catch {
			file = {};
		}
	}
	const env = (name) => str(process.env[name]);
	const cfg = {
		appKeyId: env('DSH_REMOTE_KEY_ID') || str(file.appKeyId),
		appKey: env('DSH_REMOTE_APP_KEY') || str(file.appKey),
		bucket: env('DSH_REMOTE_BUCKET') || str(file.bucket),
		cloudFile: env('DSH_REMOTE_CLOUD_FILE') || str(file.cloudFile),
		password: env('DSH_REMOTE_PASSWORD') || str(file.password),
		updatedAt: Number(file.updatedAt ?? 0),
	};
	cfg.channel = deriveChannel(cfg);
	return cfg;
}

/** 落盘。只写这 5 项 + 时间戳，权限 0600（同机其它用户读不到）。 */
export function saveConfig(partial) {
	const current = loadConfig();
	const next = {
		appKeyId: str(partial?.appKeyId) || current.appKeyId,
		appKey: str(partial?.appKey) || current.appKey,
		bucket: str(partial?.bucket) || current.bucket,
		cloudFile: str(partial?.cloudFile) || current.cloudFile,
		password: str(partial?.password) || current.password,
		updatedAt: Date.now(),
	};
	if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
	writeFileSync(CONFIG_PATH, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
	return loadConfig();
}

/**
 * 由凭据确定性派生通道参数。
 *
 * ## 为什么不需要配对码
 *
 * 通道 ID 是 `bucket + cloudFile + appKey` 的 HMAC 结果：两端配置一样 ⇒
 * 算出来一样 ⇒ 就是同一条通道。没有一次性邀约，也就没有可过期、可填错的东西。
 *
 * ## 为什么还要 password
 *
 * 通道 ID 只解决「往哪儿写」，**不提供机密性**：桶里的对象名是明文，
 * 拿到 bucket 读权限的人（或者误配了公开桶）能看到一堆 `from-phone/xxx.7z`。
 * 内容安全完全靠 7z 的 AES-256（密码不参与派生，故意不参与：
 * 密码填错时应该报「解不开」，而不是悄悄换到另一条空通道上去）。
 *
 * @returns `{ channelId, root, fingerprint }`，配置不全时返回 `null`。
 */
export function deriveChannel(cfg) {
	const bucket = str(cfg?.bucket);
	const cloudFile = sanitizeName(cfg?.cloudFile);
	const appKey = str(cfg?.appKey);
	if (!bucket || !cloudFile || !appKey) return null;
	const salt = `${ROOT}|${bucket}|${cloudFile}`;
	const channelId = createHmac('sha256', appKey)
		.update(`channel-id|${salt}`)
		.digest('hex')
		.slice(0, 12);
	const root = `${ROOT}/${cloudFile}/ch/${channelId}`;
	// 给用户对账用：两端设置页显示同一串 = 通道一致；不泄露任何密钥。
	const fingerprint = createHash('sha256')
		.update(`${salt}|${channelId}`)
		.digest('hex')
		.slice(0, 8);
	return { channelId, root, fingerprint };
}

/** 电脑端的本地状态（消费游标、生产序号）。 */
export function loadState() {
	try {
		const o = JSON.parse(readFileSync(STATE_PATH, 'utf8'));
		return {
			outSeq: Number.isFinite(Number(o?.outSeq)) ? Number(o.outSeq) : 0,
			inCursor: Number.isFinite(Number(o?.inCursor)) ? Number(o.inCursor) : 0,
			lastAppSeenAt: Number(o?.lastAppSeenAt ?? 0),
		};
	} catch {
		return { outSeq: 0, inCursor: 0, lastAppSeenAt: 0 };
	}
}

export function saveState(state) {
	if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
	writeFileSync(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}
