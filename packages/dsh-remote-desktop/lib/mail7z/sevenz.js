/**
 * 7z 打包 / 解包 —— 邮箱里每个对象都是一份标准 7z 归档。
 *
 * ## 为什么是「每次数据都过一遍 7z」
 *
 * 用户的要求：*每次数据都用 7z 标准压缩加密上传*。于是本方案不做自定义信封，
 * 桶里躺的就是货真价实的 `.7z`：LZMA 压缩 + AES-256 加密，随便拿
 * 7-Zip / WinRAR / Keka / ZArchiver 输密码都能打开 —— 这是**可自证**的加密，
 * 而不是「作者说它加密了」。
 *
 * 归档里只有一个文件 `m.json`（帧列表），所以：
 *   - 压缩率对小 JSON 有限，但事件批次里重复字段多，实测仍有 3~6 倍；
 *   - 单文件 + 固定名 ⇒ 手机端（Java 自实现 7z 读写）只需要支持「单文件、
 *     LZMA、AES-256」这一条最小路径，不需要通读整个 7z 规范。
 *
 * ## 参数选择（两端必须一致）
 *
 *   -t7z            标准 7z 容器
 *   -m0=LZMA        LZMA1（7z 的经典方法；Java 侧用官方 LZMA SDK 实现）
 *   -mx=5           常规压缩级别
 *   -mhe=off        归档头不加密，**只加密数据**
 *   -p<pwd>         AES-256（7zAES：SHA-256 迭代 2^19 次派生密钥）
 *
 * ## ⚠️ 为什么 -mhe=off
 *
 * 加密头（`-mhe=on`）需要手机端额外实现「先解头再解数据」的两段式流程，
 * 而头里只有 `m.json` 这一个固定文件名和长度，没有业务信息。
 * 数据本身仍然是完整 AES-256；两害相权，选择结构简单、可验证性好的一侧。
 * 想要更强可以在两端都把这里改成 `-mhe=on`（Java 侧已支持读，写见 reader 注释）。
 *
 * ## ⚠️ 密码经过命令行参数
 *
 * 7z 不支持用环境变量或标准输入传密码，只能 `-p<pwd>`。这意味着同一台机器上
 * 有权限枚举进程的人能看到那一瞬间的命令行。这是本机单用户场景下可接受的
 * 取舍（换成自定义加密就没有可自证性了）。介意的话把电脑端当多用户机器用
 * 不在本方案的威胁模型内。
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

const MB = 1024 * 1024;

/** 归档内那唯一一个文件的名字。两端硬编码一致。 */
export const ENTRY_NAME = 'm.json';

/** 常见安装位置（Windows 优先，其余靠 PATH）。 */
const CANDIDATES = [
	process.env.DSH_REMOTE_7Z,
	'C:\\Program Files\\7-Zip\\7z.exe',
	'C:\\Program Files (x86)\\7-Zip\\7z.exe',
	join(homedir(), 'scoop', 'apps', '7zip', 'current', '7z.exe'),
	'/usr/bin/7z',
	'/usr/local/bin/7z',
	'/opt/homebrew/bin/7z',
	'7z',
	'7za',
	'7zz',
].filter((v) => typeof v === 'string' && v !== '');

let resolved = null;

/**
 * 找到可用的 7z 可执行文件（只探测一次，结果缓存）。
 *
 * @returns `{ path, version }`；找不到时抛错并给出可操作的提示。
 */
export function resolve7z() {
	if (resolved !== null) return resolved;
	for (const candidate of CANDIDATES) {
		// 绝对路径：直接看文件在不在；裸名字：交给 PATH 解析（用 --help 试跑）。
		if (candidate.includes('/') || candidate.includes('\\')) {
			if (!existsSync(candidate)) continue;
		}
		resolved = { path: candidate, version: 'unknown' };
		return resolved;
	}
	throw new Error(
		'找不到 7z 可执行文件：请安装 7-Zip（或用环境变量 DSH_REMOTE_7Z 指向可执行文件）。' +
		'已尝试：' + CANDIDATES.join(' / '),
	);
}

/** 起一个 7z 进程，收齐 stdout 与 stderr。 */
function run7z(args, { stdin = null, timeout = 60_000 } = {}) {
	const bin = resolve7z();
	return new Promise((resolve, reject) => {
		const child = spawn(bin.path, args, { windowsHide: true });
		const out = [];
		const err = [];
		const timer = setTimeout(() => {
			try { child.kill(); } catch { /* 已退出 */ }
			reject(new Error(`7z 超时（${timeout}ms）`));
		}, timeout);
		child.stdout.on('data', (c) => out.push(c));
		child.stderr.on('data', (c) => err.push(c));
		child.on('error', (e) => {
			clearTimeout(timer);
			reject(new Error(`7z 启动失败（${bin.path}）：${e.message}`));
		});
		child.on('close', (code) => {
			clearTimeout(timer);
			resolve({ code, stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString('utf8') });
		});
		if (stdin !== null) child.stdin.end(stdin);
		else child.stdin.end();
	});
}

function tmpPath() {
	return join(tmpdir(), `dsh-remote-${randomBytes(8).toString('hex')}.7z`);
}

/**
 * 把一帧列表打成加密 7z。
 *
 * @param value - 可 JSON 序列化的值
 * @param password - 非空密码
 * @returns 7z 字节
 */
export async function packJson(value, password) {
	if (typeof password !== 'string' || password === '') throw new Error('缺少 7z 加密密码');
	const payload = Buffer.from(JSON.stringify(value), 'utf8');
	// 帧很小（几百字节到几十 KB），上限给 8MB 足够挡住跑飞的情况。
	if (payload.length > 8 * MB) throw new Error(`单帧过大（${payload.length} 字节）`);
	const out = tmpPath();
	try {
		const res = await run7z([
			'a', '-t7z', `-m0=LZMA`, '-mx=5', '-mhe=off',
			`-p${password}`, `-si${ENTRY_NAME}`, '-bd', '-bso0', '-bsp0', '-y', out,
		], { stdin: payload });
		if (res.code !== 0) throw new Error(`7z 打包失败（exit ${res.code}）：${res.stderr.slice(0, 200)}`);
		return readFileSync(out);
	} finally {
		try { unlinkSync(out); } catch { /* 已清理 */ }
	}
}

/**
 * 解开一份加密 7z，返回里面的 JSON。
 *
 * 密码错时 7z 报 `Data Error in encrypted file. Wrong password?`，
 * 这里翻译成一句人话，避免用户对着 7z 的英文原文猜。
 */
export async function unpackJson(bytes, password) {
	if (typeof password !== 'string' || password === '') throw new Error('缺少 7z 解密密码');
	const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
	if (buf.length < 32) throw new Error('对象太小，不像 7z 归档');
	const file = tmpPath();
	let res;
	try {
		const { writeFileSync } = await import('node:fs');
		writeFileSync(file, buf);
		res = await run7z(['e', '-so', `-p${password}`, '-y', file]);
	} finally {
		try { unlinkSync(file); } catch { /* 已清理 */ }
	}
	if (res.code !== 0 || res.stdout.length === 0) {
		const err = res.stderr;
		if (/Wrong password|Data Error in encrypted/i.test(err)) {
			throw new Error('7z 解不开：密码不对（两端密码必须完全一致，区分大小写与空格）');
		}
		throw new Error(`7z 解包失败（exit ${res.code}）：${err.slice(0, 200)}`);
	}
	try {
		return JSON.parse(res.stdout.toString('utf8'));
	} catch (error) {
		throw new Error(`7z 内容不是合法 JSON：${error.message}`);
	}
}

/** 仅供测试/日志：打印实际用到的 7z 路径。 */
export function sevenZipPath() {
	return resolve7z().path;
}
