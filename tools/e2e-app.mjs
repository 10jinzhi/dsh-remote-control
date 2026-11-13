/**
 * 端到端测试（手机端）—— 真实 7z + 假中继 + **Java 客户端核心**。
 *
 * ```
 *   JvmClientTest ──7z/邮箱──► MailBridge ──HTTP──► 假中继(17982)
 *   （APK 同一份代码）◄─7z/邮箱──         ◄──SSE──┘
 * ```
 *
 * 与 `tools/e2e.mjs` 的分工：
 *   · e2e.mjs 用 **Node 版**手机模拟器验证传输层与渲染层；
 *   · 本脚本用 **Java 版**手机核心（`Config` / `B2Client` / `Mailbox` /
 *     `RemoteLink` / `SevenZip*`）验证 APK 里真正要跑的那份代码。
 *
 * 两种后端：
 *   · 默认（不加参数）：`tools/local-b2.mjs` 本地桩 —— 可反复跑，不消耗
 *     Backblaze 的 transaction 配额（免费额度按天计数，真桶跑几轮就用完了）；
 *   · `--real`：真桶。用于发版前的最终验收，跑完自动清空本次前缀。
 *
 * 运行：
 *   node tools/e2e-app.mjs            本地桩（日常回归）
 *   node tools/e2e-app.mjs --real     真 B2（发版验收，需要凭据）
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { startFakeRelay } from './fake-relay.mjs';
import { startLocalB2 } from './local-b2.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const RELAY_PORT = 17982;
const TOKEN = 'e2e-app-token-0123456789ab';
const CLOUD_FILE = `e2eapp-${Date.now().toString(36)}`;
const CLASSES = join(ROOT, 'tools', 'out', 'classes-app');
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

// ---------------------------------------------------------------- JDK

/** 找一个能用的 javac（不依赖 PATH：开发机上通常只有 IDE 自带的 JBR）。 */
function resolveJdk() {
	const exe = process.platform === 'win32' ? '.exe' : '';
	const candidates = [
		process.env.JAVA_HOME ? join(process.env.JAVA_HOME, 'bin', `javac${exe}`) : null,
		'C:/Users/FoolA/.jdks/corretto-17.0.7/bin/javac.exe',
		'C:/Program Files/JetBrains/IntelliJ IDEA 2023.1.3/jbr/bin/javac.exe',
		'C:/Program Files/Android/Android Studio/jbr/bin/javac.exe',
		'/usr/lib/jvm/default-java/bin/javac',
	];
	for (const candidate of candidates) {
		if (candidate !== null && existsSync(candidate)) {
			return { javac: candidate, java: join(candidate, '..', `java${exe}`), version: readJavaVersion(candidate) };
		}
	}
	throw new Error('找不到 javac：设置 JAVA_HOME，或改 tools/e2e-app.mjs 里的候选路径');
}

function readJavaVersion(javac) {
	try {
		return execFileSync(javac, ['-version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
	} catch (error) {
		return String(error?.stdout ?? '').trim() || '未知';
	}
}

// ---------------------------------------------------------------- 编译

/**
 * 收集要编译的源码（手机端核心 + LZMA SDK + JVM 测试入口）。
 *
 * **不包含** `dshremote/ui/`：那是 Android 界面层（Activity / Service / WebView），
 * 依赖 android.jar，只能在 APK 构建里编译；本测试要的是「不碰 Android API」
 * 的那一部分，正是为了能在普通 JVM 上跑。
 */
function collectSources() {
	const list = [];
	const push = (dir) => {
		for (const name of readdirSync(dir)) if (name.endsWith('.java')) list.push(join(dir, name));
	};
	push(join(ROOT, 'android', 'app', 'src', 'main', 'java', 'dshremote'));
	push(join(ROOT, 'android', 'app', 'src', 'main', 'java', 'dshremote', 'z7'));
	push(join(ROOT, 'tools', 'jvm', 'dshremote'));
	push(join(ROOT, 'tools', 'jvm', 'dshremote', 'z7')); // 手动 7z 自测工具（可选，进不了 APK）
	// LZMA SDK 连它自带的示例（LzmaAlone / LzmaBench）一起编，省得筛文件；
	// 多出来的 .class 不进 APK。
	const walk = (dir) => {
		for (const name of readdirSync(dir)) {
			const full = join(dir, name);
			if (statSync(full).isDirectory()) walk(full);
			else if (name.endsWith('.java')) list.push(full);
		}
	};
	walk(join(ROOT, 'android', 'app', 'src', 'main', 'java', 'SevenZip'));
	return list;
}

/**
 * 编译（增量：任一源码比 stamp 新就重编）。
 *
 * 源文件列表**直接作为参数**传入，不写 `@argfile`：javac 读 argfile 用的是
 * 平台默认编码（本机是 GBK），而本项目路径里有中文 → 必然 MalformedInput。
 * 参数走 CreateProcessW 的 UTF-16，反而更稳；30 多个文件也远不到 32K 上限。
 */
function compileJdk(jdk) {
	const sources = collectSources();
	const stamp = join(CLASSES, '.stamp');
	const newest = Math.max(...sources.map((f) => statSync(f).mtimeMs));
	if (existsSync(stamp) && statSync(stamp).mtimeMs > newest) {
		console.log(`  编译产物已是最新（${sources.length} 个源文件）`);
		return false;
	}
	mkdirSync(CLASSES, { recursive: true });
	execFileSync(jdk.javac, ['-encoding', 'UTF-8', '-nowarn', '-d', CLASSES, ...sources], {
		stdio: ['ignore', 'pipe', 'pipe'],
		encoding: 'utf8',
	});
	writeFileSync(stamp, new Date().toISOString());
	console.log(`  编译完成：${sources.length} 个源文件 → ${CLASSES}`);
	return true;
}

// ---------------------------------------------------------------- Java 客户端

/** 跑一个 Java 入口类，逐行解析 `{"check","ok","detail"}`。 */
function runJava(jdk, mainClass, args, timeoutMs) {
	return new Promise((resolveRun) => {
		const child = spawn(jdk.java, [
			'-Dfile.encoding=UTF-8',
			'-cp', CLASSES,
			`dshremote.${mainClass}`,
			...args,
		], { stdio: ['ignore', 'pipe', 'pipe'] });

		const checks = [];
		let out = '';
		let err = '';
		const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);

		child.stdout.setEncoding('utf8');
		child.stdout.on('data', (chunk) => {
			out += chunk;
			let idx;
			while ((idx = out.indexOf('\n')) >= 0) {
				const line = out.slice(0, idx).trim();
				out = out.slice(idx + 1);
				if (line === '') continue;
				if (line.startsWith('{')) {
					try {
						const parsed = JSON.parse(line);
						if (typeof parsed.check === 'string') {
							checks.push(parsed);
							console.log(`  ${parsed.ok ? '✅' : '❌'} ${parsed.check}  ${parsed.detail ?? ''}`);
							continue;
						}
					} catch {
						/* 不是结果行，落到下面当日志 */
					}
				}
				console.log(`  [java] ${line}`);
			}
		});
		child.stderr.setEncoding('utf8');
		child.stderr.on('data', (chunk) => {
			err += chunk;
			for (const line of chunk.split('\n')) if (line.trim() !== '') console.log(`  [java:err] ${line.trim()}`);
		});
		child.on('close', (code) => {
			clearTimeout(timer);
			resolveRun({ code, checks, stderr: err });
		});
	});
}

// ---------------------------------------------------------------- 主流程

async function main() {
	/*
	 * 凭据：
	 *   · --real：复制真机那份 `$DSH_HOME/dsh-remote-control/config.json` 到临时
	 *     DSH_HOME，只换 cloudFile ⇒ 不碰真通道、不碰真游标；
	 *   · 默认：本地桩，5 项随便填（B2 客户端只校验非空，通道派生照样算）。
	 */
	let baseConfig;
	if (USE_REAL) {
		const realHome = process.env.DSH_HOME && process.env.DSH_HOME.trim() !== ''
			? process.env.DSH_HOME.trim()
			: join(homedir(), '.dsh');
		const realConfigPath = join(realHome, 'dsh-remote-control', 'config.json');
		try {
			baseConfig = JSON.parse(readFileSync(realConfigPath, 'utf8'));
		} catch {
			console.error(`找不到可用凭据：${realConfigPath}`);
			console.error('先跑一次：node tools/set-credentials.mjs --from <b2-credentials.json> --password <7z密码>');
			process.exitCode = 2;
			return;
		}
	} else {
		baseConfig = {
			appKeyId: 'local-key-id',
			appKey: 'local-application-key',
			bucket: 'local-bucket',
			password: LOCAL_PASSWORD,
		};
	}

	const home = mkdtempSync(join(tmpdir(), 'dsh-remote-control-app-'));
	mkdirSync(join(home, 'dsh-remote-control'), { recursive: true });
	writeFileSync(
		join(home, 'dsh-remote-control', 'config.json'),
		`${JSON.stringify({ ...baseConfig, cloudFile: CLOUD_FILE, updatedAt: Date.now() }, null, 2)}\n`,
	);
	process.env.DSH_HOME = home;
	for (const key of [
		'DSH_REMOTE_KEY_ID', 'DSH_REMOTE_APP_KEY', 'DSH_REMOTE_BUCKET',
		'DSH_REMOTE_CLOUD_FILE', 'DSH_REMOTE_PASSWORD', 'DSH_REMOTE_B2_AUTH',
	]) {
		delete process.env[key];
	}

	// 本地桩：必须在 import b2.js 之前把环境变量准备好（模块读的是运行时 env，
	// 但保持「先设后用」的顺序更不容易出错）。
	let stub = null;
	if (!USE_REAL) {
		stub = await startLocalB2({ bucket: baseConfig.bucket });
		process.env.DSH_REMOTE_B2_AUTH = `${stub.base}/b2api/v3/b2_authorize_account`;
	}

	const { loadConfig } = await import('../lib/mail7z/config.js');
	const { B2Client } = await import('../lib/mail7z/b2.js');
	const { Mailbox } = await import('../lib/mail7z/mailbox.js');
	const { packJson, unpackJson, sevenZipPath } = await import('../lib/mail7z/sevenz.js');
	const { MailBridge } = await import('../lib/mail7z/bridge.js');

	const loaded = loadConfig();
	assert.ok(loaded.channel !== null, '配置不完整：需要 keyId / appKey / bucket / cloudFile / password 五项');

	const jdk = resolveJdk();

	console.log('== 环境 ==');
	console.log(`  后端       ${USE_REAL ? '真 Backblaze B2' : `本地桩 ${stub.base}`}`);
	console.log(`  DSH_HOME   ${home}`);
	console.log(`  7z         ${sevenZipPath()}`);
	console.log(`  JDK        ${jdk.version}`);
	console.log(`  bucket     ${loaded.bucket}`);
	console.log(`  通道       ${loaded.channel.channelId}（指纹 ${loaded.channel.fingerprint}）`);
	console.log(`  前缀       ${loaded.channel.root}/`);

	const relay = await startFakeRelay({ port: RELAY_PORT, token: TOKEN });
	console.log(`  假中继     http://127.0.0.1:${RELAY_PORT}`);

	const client = new B2Client(loaded);
	const box = new Mailbox({
		client, channel: loaded.channel, password: loaded.password, pack: packJson, unpack: unpackJson,
	});
	try {
		await box.wipe(); // 干净起步（真桶时这个名字带时间戳，只可能是上次没跑完的）
	} catch (error) {
		console.log(`  ⚠️ 起步清空失败（继续）：${error.message}`);
	}

	const bridge = new MailBridge({ relayToken: TOKEN, relayPort: RELAY_PORT, logger: null });
	await bridge.reload();
	bridge.start();

	/*
	 * 截获桥写出去的每一个对象。
	 *
	 * 为什么不在跑完之后去桶里查：两条队列都是「读走即删」，Java 客户端一
	 * 退出，out/ 已经被消费干净了（这正是协议该有的样子）。想知道「线上到底
	 * 传了什么字节」，只能在写的那一刻留样。
	 *
	 * 为什么打在 prototype 上而不是 bridge.client 上：桥会在配置 mtime 变化
	 * 时重新 `new B2Client(...)`，实例级补丁会随着实例被丢掉；类级补丁对
	 * 之后每一次 reload 出来的客户端都有效。
	 */
	const captured = [];
	const originalPut = B2Client.prototype.put;
	B2Client.prototype.put = async function capturePut(key, bytes) {
		captured.push({ key, bytes });
		return originalPut.call(this, key, bytes);
	};

	// 手机上要填的那 5 项，原样写成 JSON 交给 Java 侧
	const phoneConfig = join(home, 'phone-config.json');
	const phoneJson = {
		appKeyId: loaded.appKeyId,
		appKey: loaded.appKey,
		bucket: loaded.bucket,
		cloudFile: loaded.cloudFile,
		password: loaded.password,
	};
	if (!USE_REAL) phoneJson.authorizeUrl = process.env.DSH_REMOTE_B2_AUTH;
	writeFileSync(phoneConfig, `${JSON.stringify(phoneJson, null, 2)}\n`);

	console.log('\n== 编译（APK 里同一份 Java 核心） ==');
	compileJdk(jdk);

	/*
	 * 多电脑隔离：纯本地、不联网。放在网络测试之前 —— 如果「键到底写进了
	 * 哪个前缀」都错了，后面的链路测试会表现成随机超时，很难归因。
	 */
	console.log('\n== 断言（多电脑隔离，纯本地） ==');
	const profileRun = await runJava(jdk, 'ProfilesTest', [join(home, 'profiles')], 60_000);
	for (const item of profileRun.checks) {
		results.push({
			name: `profile · ${item.check}`,
			pass: item.ok === true,
			error: item.ok ? undefined : item.detail,
		});
	}
	assert.ok(
		profileRun.checks.length >= 5,
		`多电脑隔离只报了 ${profileRun.checks.length} 项（预期 ≥5），stderr：${profileRun.stderr.slice(0, 300)}`,
	);

	console.log('\n== 断言（Java 客户端 ↔ 电脑端桥 ↔ 7z 邮箱） ==');
	try {
		const run = await runJava(jdk, 'JvmClientTest', [phoneConfig, '--subscribe'], 180_000);
		for (const item of run.checks) {
			results.push({
				name: `java · ${item.check}`,
				pass: item.ok === true,
				error: item.ok ? undefined : item.detail,
			});
		}
		assert.ok(
			run.checks.length >= 6,
			`Java 侧只报了 ${run.checks.length} 项（预期 ≥6），stderr：${run.stderr.slice(0, 300)}`,
		);

		await check('电脑端确实收到了手机帧', async () => {
			assert.ok(bridge.stats.inFrames > 0, '桥一帧都没收到');
			return `in ${bridge.stats.inFrames} 帧 / out ${bridge.stats.outFrames} 帧`;
		});

		await check('桶里的对象是标准 7z（魔数 + 能解开）', async () => {
			const outs = captured.filter((c) => c.key.startsWith(box.prefix('desktop')));
			assert.ok(outs.length > 0, '桥一个 from-desktop/ 对象都没写');
			const { key, bytes } = outs[0];
			assert.equal(bytes.subarray(0, 6).toString('hex'), '377abcaf271c', '不是 7z 容器');
			const payload = await unpackJson(bytes, loaded.password);
			assert.equal(payload.v, 1);
			assert.ok(Array.isArray(payload.frames) && payload.frames.length > 0, '帧数组为空');
			const kinds = [...new Set(payload.frames.map((f) => f.kind))].join('/');
			return `${key.split('/').pop()} ${bytes.length}B 帧类型=${kinds}`;
		});

		await check('用错密码解同一个对象会失败（加密确实生效）', async () => {
			const first = captured.find((c) => c.key.startsWith(box.prefix('desktop')));
			assert.ok(first !== undefined, '没有可检验的对象');
			await assert.rejects(() => unpackJson(first.bytes, 'definitely-wrong'), /密码不对/);
		});

		await check('所有上传都落在本通道前缀下（没有写串目录）', async () => {
			assert.ok(captured.length > 0, '没有任何上传');
			const root = `${loaded.channel.root}/`;
			const stray = captured.filter((c) => !c.key.startsWith(root));
			assert.equal(stray.length, 0, `串出去了：${stray.slice(0, 3).map((c) => c.key).join(', ')}`);
			const queues = [...new Set(captured.map((c) => (c.key.includes('/from-desktop/') ? 'desktop' : c.key.includes('/from-phone/') ? 'phone' : '?')))];
			return `${captured.length} 次上传 / 队列 ${queues.join(',')}`;
		});

		await check('电脑端把 from-phone/ 队列全部消费掉了（不留未处理帧）', async () => {
			if (stub === null) return `已处理 ${bridge.stats.inFrames} 帧（真桶不查残留）`;
			// 手机刚退出，桥可能还在半路上；给它一个收敛窗口再断言
			const deadline = Date.now() + 8_000;
			let left = stub.names().filter((n) => n.includes('/from-phone/'));
			while (left.length > 0 && Date.now() < deadline) {
				await new Promise((r) => setTimeout(r, 300));
				left = stub.names().filter((n) => n.includes('/from-phone/'));
			}
			assert.equal(left.length, 0, `还剩 ${left.length} 个未处理：${left.slice(0, 3).join(', ')}`);
			return `已处理 ${bridge.stats.inFrames} 帧`;
		});
	} finally {
		console.log('\n== 清理 ==');
		bridge.stop();
		relay.close();
		let wiped = 0;
		try {
			wiped = await box.wipe();
		} catch (error) {
			console.log(`  ⚠️ 清理失败：${error.message}`);
		}
		console.log(`  已删除对象 ${wiped} 个`);
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
	console.error('E2E(app) 崩溃：', error);
	// 假中继可能还占着端口，不 exit 进程会挂住（真机上没这个问题，测试里有）
	process.exit(1);
});
