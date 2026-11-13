/**
 * 手工构建 APK —— 不依赖 Gradle / Android Studio 工程。
 *
 * ```
 *   aapt2 compile  res/*.xml  →  res.zip
 *   aapt2 link     res.zip + manifest + assets + android.jar  →  app-unsigned.apk
 *   javac          src/main/java/**  + android.jar            →  classes/**.class
 *   java -cp d8.jar classes → classes.dex（--min-api 26）
 *   jar            classes.dex 塞进 app-unsigned.apk
 *   zipalign       4 字节对齐
 *   apksigner      签名（首次自动生成 keystore）
 * ```
 *
 * 为什么不用 Gradle：这个 APK 只有 2 个 Java 包、一套资源、没有第三方依赖，
 * Gradle 拉下来的 AGP 比产物本身大两个数量级；而 build-tools 里的
 * aapt2/d8/apksigner 就是这个流程的全部真相。
 *
 * 运行：node tools/build-apk.mjs [--release]
 *   --release  额外跑一遍 apksigner verify + aapt2 dump badging 的详细校验
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const APP = join(ROOT, 'android', 'app', 'src', 'main');
const BUILD = join(ROOT, 'android', 'build');
const OUT = join(ROOT, 'out');

const AAPT2 = join(ROOT, '_toolchain', 'android-14', 'aapt2.exe');
const D8_JAR = join(ROOT, '_toolchain', 'android-14', 'lib', 'd8.jar');
const ZIPALIGN = join(ROOT, '_toolchain', 'android-14', 'zipalign.exe');
const APKSIGNER_JAR = join(ROOT, '_toolchain', 'android-14', 'lib', 'apksigner.jar');
const ANDROID_JAR = join(ROOT, '_toolchain', 'android-35', 'android.jar');

const MIN_SDK = 26;
const TARGET_SDK = 34;
const KEYSTORE = join(OUT, 'dsh-remote.keystore');
const KS_PASS = 'dsh-remote-local';

const steps = [];
function step(name, fn) {
	const started = Date.now();
	process.stdout.write(`  ${name} … `);
	const detail = fn();
	const ms = Date.now() - started;
	steps.push({ name, ms, detail });
	console.log(`ok (${ms}ms)${detail ? `  ${detail}` : ''}`);
}

// ---------------------------------------------------------------- JDK

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
			const bin = join(candidate, '..');
			return {
				bin,
				java: join(bin, `java${exe}`),
				javac: candidate,
				jar: join(bin, `jar${exe}`),
				keytool: join(bin, `keytool${exe}`),
			};
		}
	}
	throw new Error('找不到 javac：设置 JAVA_HOME');
}

const jdk = resolveJdk();
/** 子进程统一环境：d8.bat / apksigner.bat 都靠 JAVA_HOME 找 java */
const childEnv = { ...process.env, JAVA_HOME: jdk.bin, PATH: `${jdk.bin};${process.env.PATH ?? ''}` };

/**
 * 转成「相对项目根」的路径，并且所有子进程都以项目根为工作目录。
 *
 * 踩过的坑：aapt2（原生 exe，不是 Java）用的是系统 ANSI 代码页，本仓库
 * 路径里有中文（`dsh远程连接自研究版本`）→ 绝对路径直接 `failed to open
 * directory`。相对路径绕过了编码问题，代价只是所有调用必须带 cwd。
 * zipalign 同样是原生 exe，一并照此处理。
 */
function R(path) {
	return path.startsWith(ROOT) ? path.slice(ROOT.length + 1).replaceAll('\\', '/') : path;
}

function run(cmd, args, options = {}) {
	try {
		return execFileSync(cmd, args, {
			cwd: ROOT,
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'pipe'],
			env: childEnv,
			maxBuffer: 32 * 1024 * 1024,
			...options,
		});
	} catch (error) {
		const out = `${error.stdout ?? ''}${error.stderr ?? ''}`.trim();
		throw new Error(`${cmd.split(/[\\/]/).pop()} ${args[0] ?? ''} 失败：\n${out || error.message}`);
	}
}

// ---------------------------------------------------------------- 源码清单

/**
 * 参与编译的 Java 源码。
 *
 * `SevenZip/` 只留 `z7/` 真正用到的那几个类（LZMA 编解码器 + 它的区间编码、
 * 滑窗依赖 + `ICodeProgress` 接口）。SDK 自带的 `LzmaAlone` / `LzmaBench` /
 * `CRC` 是命令行示例与基准，会读写本地文件，**不要加回来**。
 * `Z7Test` 是开发机上的自测入口，同理。
 */
function javaSources() {
	const list = [];
	const add = (dir) => {
		for (const name of readdirSync(dir)) {
			if (name === 'Z7Test.java') continue;
			if (name.endsWith('.java')) list.push(join(dir, name));
		}
	};
	add(join(APP, 'java', 'dshremote'));
	add(join(APP, 'java', 'dshremote', 'z7'));
	add(join(APP, 'java', 'dshremote', 'ui'));
	add(join(APP, 'java', 'SevenZip', 'Compression', 'LZ'));
	add(join(APP, 'java', 'SevenZip', 'Compression', 'LZMA'));
	add(join(APP, 'java', 'SevenZip', 'Compression', 'RangeCoder'));
	list.push(join(APP, 'java', 'SevenZip', 'ICodeProgress.java'));
	return list;
}

function classFiles(dir) {
	const out = [];
	for (const name of readdirSync(dir)) {
		const full = join(dir, name);
		if (statSync(full).isDirectory()) out.push(...classFiles(full));
		else if (name.endsWith('.class')) out.push(full);
	}
	return out;
}

// ---------------------------------------------------------------- 主流程

function main() {
	for (const [label, path] of [['aapt2', AAPT2], ['d8.jar', D8_JAR], ['zipalign', ZIPALIGN], ['apksigner.jar', APKSIGNER_JAR], ['android.jar', ANDROID_JAR]]) {
		if (!existsSync(path)) throw new Error(`缺少 ${label}：${path}\n先把 build-tools 34 与 platform-35 解压到 _toolchain/`);
	}
	const manifest = readFileSync(join(APP, 'AndroidManifest.xml'), 'utf8');
	const versionName = /android:versionName="([^"]+)"/.exec(manifest)?.[1] ?? '0.0.0';
	const versionCode = Number(/android:versionCode="(\d+)"/.exec(manifest)?.[1] ?? 1);
	const apkName = `dsh-remote-control-${versionName}.apk`;

	rmSync(BUILD, { recursive: true, force: true });
	mkdirSync(BUILD, { recursive: true });
	mkdirSync(OUT, { recursive: true });

	console.log('== 构建 ==');
	console.log(`  版本       ${versionName} (${versionCode})`);
	console.log(`  SDK        min ${MIN_SDK} / target ${TARGET_SDK}`);
	console.log(`  JDK        ${jdk.bin}`);
	console.log('');

	// ① 资源编译
	step('aapt2 compile', () => {
		run(AAPT2, ['compile', '--dir', R(join(APP, 'res')), '-o', R(join(BUILD, 'res.zip'))]);
		return `${(statSync(join(BUILD, 'res.zip')).size / 1024).toFixed(1)}KB`;
	});

	// ② 资源链接（同时把 assets 与 manifest 打进 APK）
	const unsigned = join(BUILD, 'app-unsigned.apk');
	step('aapt2 link', () => {
		run(AAPT2, [
			'link',
			'-o', R(unsigned),
			'-I', R(ANDROID_JAR),
			'--manifest', R(join(APP, 'AndroidManifest.xml')),
			'--min-sdk-version', String(MIN_SDK),
			'--target-sdk-version', String(TARGET_SDK),
			'--version-code', String(versionCode),
			'--version-name', versionName,
			'-A', R(join(APP, 'assets')),
			'--auto-add-overlay',
			R(join(BUILD, 'res.zip')),
		]);
		return `${(statSync(unsigned).size / 1024).toFixed(1)}KB`;
	});

	// ③ 编译 Java
	const classesDir = join(BUILD, 'classes');
	const sources = javaSources();
	step('javac', () => {
		run(jdk.javac, [
			'-encoding', 'UTF-8',
			'-nowarn',
			'-source', '11',
			'-target', '11',
			'-classpath', R(ANDROID_JAR),
			'-d', R(classesDir),
			...sources.map(R),
		]);
		const total = classFiles(classesDir).length;
		return `${sources.length} 个源文件 → ${total} 个 class`;
	});

	// ④ dex
	const dexDir = join(BUILD, 'dex');
	step('d8', () => {
		mkdirSync(dexDir, { recursive: true });
		run(jdk.java, ['-cp', R(D8_JAR), 'com.android.tools.r8.D8', 
			'--release',
			'--min-api', String(MIN_SDK),
			'--lib', R(ANDROID_JAR),
			'--output', R(dexDir),
			...classFiles(classesDir).map(R),
		]);
		const dex = join(dexDir, 'classes.dex');
		if (!existsSync(dex)) throw new Error('d8 没有产出 classes.dex');
		return `${(statSync(dex).size / 1024).toFixed(1)}KB`;
	});

	// ⑤ 把 dex 塞进 APK（jar 就是 zip 工具，JDK 自带，比装 7-Zip/zip 依赖稳）
	step('jar uf classes.dex', () => {
		run(jdk.jar, ['--update', '--file', R(unsigned), '-C', R(dexDir), 'classes.dex']);
		return `${(statSync(unsigned).size / 1024).toFixed(1)}KB`;
	});

	// ⑥ 对齐
	const aligned = join(BUILD, 'app-aligned.apk');
	step('zipalign', () => {
		run(ZIPALIGN, ['-f', '-p', '4', R(unsigned), R(aligned)]);
		return '4 字节对齐';
	});

	// ⑦ 签名
	if (!existsSync(KEYSTORE)) {
		step('keytool（首次生成调试证书）', () => {
			run(jdk.keytool, [
				'-genkeypair', '-noprompt',
				'-keystore', R(KEYSTORE),
				'-alias', 'dsh-remote-control',
				'-keyalg', 'RSA',
				'-keysize', '2048',
				'-validity', '10950',
				'-storepass', KS_PASS,
				'-keypass', KS_PASS,
				'-dname', 'CN=DSH Remote Control, OU=self-research, O=DSH Remote, L=Shanghai, ST=Shanghai, C=CN',
			]);
			return KEYSTORE.replace(ROOT, '.');
		});
	}

	const apk = join(OUT, apkName);
	step('apksigner sign', () => {
		run(jdk.java, ['-jar', R(APKSIGNER_JAR),
			'sign',
			'--ks', R(KEYSTORE),
			'--ks-key-alias', 'dsh-remote-control',
			'--ks-pass', `pass:${KS_PASS}`,
			'--key-pass', `pass:${KS_PASS}`,
			'--min-sdk-version', String(MIN_SDK),
			'--out', R(apk),
			R(aligned),
		]);
		return apk.replace(ROOT, '.');
	});

	// ⑧ 校验
	const verify = run(jdk.java, ['-jar', R(APKSIGNER_JAR), 'verify', '--print-certs', R(apk)]);
	const badging = run(AAPT2, ['dump', 'badging', R(apk)]);
	const certLine = /Signer #1 certificate DN: (.+)/.exec(verify)?.[1]?.trim() ?? '(未打印)';
	const packageLine = /package: (.+)/.exec(badging)?.[1]?.trim() ?? '';
	const launchable = /launchable-activity: name='([^']+)'/.exec(badging)?.[1] ?? '';
	const sdkLine = /sdkVersion:'(\d+)'[\s\S]*?targetSdkVersion:'(\d+)'/.exec(badging);
	const sha256 = createHash('sha256').update(readFileSync(apk)).digest('hex');

	console.log('\n== 产物 ==');
	console.log(`  文件       ${apk}`);
	console.log(`  大小       ${(statSync(apk).size / 1024).toFixed(1)}KB`);
	console.log(`  包名       ${packageLine}`);
	console.log(`  入口       ${launchable}`);
	console.log(`  SDK        ${sdkLine ? `${sdkLine[1]} / ${sdkLine[2]}` : '?'}`);
	console.log(`  签名       ${certLine}`);
	console.log(`  文件 SHA-256 ${sha256}`);

	const summary = {
		apk: apk.replace(ROOT, '.'),
		versionName,
		versionCode,
		minSdk: MIN_SDK,
		targetSdk: TARGET_SDK,
		bytes: statSync(apk).size,
		sha256,
		signer: certLine,
		steps,
		builtAt: new Date().toISOString(),
	};
	writeFileSync(join(BUILD, 'build-report.json'), `${JSON.stringify(summary, null, 2)}\n`);

	const total = steps.reduce((sum, s) => sum + s.ms, 0);
	console.log(`\n== 完成：${steps.length} 步 / ${(total / 1000).toFixed(1)}s ==`);
	return summary;
}

try {
	main();
} catch (error) {
	console.error(`\n构建失败：${error.message}`);
	process.exit(1);
}
