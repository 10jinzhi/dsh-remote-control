/**
 * 配对设置页 —— 挂在 DSH 自己的 Web 端口上（不是中继端口）。
 *
 * 页面长得跟手机 APK 的「设置」一致：同样是那 5 个输入框，同样的顺序，
 * 填完点保存，两端算出来的通道 ID 相同即可连通。
 *
 * 路由（前缀 `/api/dsh-remote`）：
 *
 *   GET  /state     → 当前配置（密码打码）+ 运行时状态
 *   POST /config    → 保存 5 项并让桥立即重载（不用重启 DSH）
 *   POST /test      → 用当前配置真跑一遍「上传一个 7z → 读回 → 删掉」
 *   POST /unbind    → 清空该通道在桶里的所有对象
 */
import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import { defaultCloudFile, loadConfig, missingFields, sanitizeName, saveConfig } from './config.js';
import { B2Client } from './b2.js';
import { Mailbox } from './mailbox.js';
import { packJson, unpackJson } from './sevenz.js';

const ROUTE = '/api/dsh-remote';

function mask(value) {
	const s = typeof value === 'string' ? value : '';
	if (s === '') return '';
	if (s.length <= 6) return `${s.slice(0, 1)}••••`;
	return `${s.slice(0, 3)}••••••${s.slice(-2)}`;
}

function json(res, status, payload) {
	res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
	res.end(JSON.stringify(payload));
}

function readBody(req) {
	return new Promise((resolve) => {
		const chunks = [];
		req.on('data', (c) => chunks.push(c));
		req.on('end', () => {
			try {
				resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
			} catch {
				resolve({});
			}
		});
	});
}

/**
 * 真跑一遍往返：上传一个探针 7z、读回、比对、删掉。
 *
 * 这一步是「点一下就确认」，比让用户自己猜「配对成功没有」有用得多：
 * 授权、桶、前缀、7z、密码、删除权限六件事一次全测到。
 */
/**
 * 设置页那个「测试往返」按钮。
 *
 * 走**独立的 `self/` 前缀**，不碰 `from-phone/` 与 `from-desktop/`：
 * 那两条是活队列，塞一个探测对象进去会被对面当成真帧消费掉（手机端游标
 * 还会因此前移），自检就变成了一次副作用。手机端 `SelfTest.java` 用同一个
 * 前缀约定，两边可以互相验证同一条通道。
 */
async function selfTest(cfg) {
	const missing = missingFields(cfg);
	if (missing.length > 0) return { ok: false, message: `还差：${missing.join(' / ')}` };
	const started = Date.now();
	const nonce = randomBytes(9).toString('hex');
	const client = new B2Client(cfg, () => {});
	const key = `${cfg.channel.root}/self/${started}.7z`;
	try {
		const archive = await packJson({
			v: 1,
			frames: [{ kind: 'selftest', at: started, nonce, probe: 'self-test' }],
		}, cfg.password);

		// ① 上传 ② 列举（确认真的进了桶） ③ 下载 ④ 解密比对 ⑤ 删除
		await client.put(key, archive);
		const uploadMs = Date.now() - started;

		const files = await client.list(`${cfg.channel.root}/self/`, { startFileName: key, maxFileCount: 5 });
		const hit = files.find((f) => f.fileName === key);
		if (hit === undefined) throw new Error('上传返回成功，但桶里列举不到这个对象（桶名 / 权限？）');

		const back = await client.get(key);
		if (back === null) throw new Error('对象列举得到但下载不回来（桶是私有的，key 没有读权限？）');
		const parsed = await unpackJson(back, cfg.password);
		if (parsed?.frames?.[0]?.nonce !== nonce) throw new Error('解出来的内容不是刚写进去的那份（通道 ID 冲突？）');

		const deleted = await client.deleteVersion(hit.fileName, hit.fileId);
		return {
			ok: true,
			ms: Date.now() - started,
			putMs: uploadMs,
			bytes: archive.length,
			key,
			channel: cfg.channel.channelId,
			fingerprint: cfg.channel.fingerprint,
			deleted,
			message: '往返正常：打包 → 上传 → 列举 → 下载 → 解密 → 删除 全部通过',
		};
	} catch (error) {
		return { ok: false, ms: Date.now() - started, message: String(error?.message ?? error) };
	}
}

export function createSettingsHandler({ bridge, logger }) {
	const log = (m) => logger?.info?.(`[dsh-remote] ${m}`) ?? console.log(`[dsh-remote] ${m}`);

	return async function handle(req, res) {
		const url = new URL(req.url ?? '/', 'http://127.0.0.1');
		const action = url.pathname.slice(ROUTE.length);
		try {
			if (req.method === 'GET' && (action === '' || action === '/')) {
				res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
				res.end(PAGE);
				return;
			}

			if (req.method === 'GET' && action === '/state') {
				const cfg = loadConfig();
				const machine = hostname();
				json(res, 200, {
					config: {
						appKeyId: cfg.appKeyId,
						appKey: mask(cfg.appKey),
						appKeySet: cfg.appKey !== '',
						bucket: cfg.bucket,
						cloudFile: cfg.cloudFile,
						passwordSet: cfg.password !== '',
						passwordMask: mask(cfg.password),
					},
					// 还没填云端文件名时，把「本机机器名派生出来的短名」交给前端预填：
					// 每台电脑默认为自己一个名字，就不会两台机器撞进同一条队列。
					suggestedCloudFile: cfg.cloudFile === '' ? defaultCloudFile(machine) : '',
					hostname: machine,
					status: bridge?.status?.() ?? {},
					missing: missingFields(cfg),
				});
				return;
			}

			if (req.method === 'POST' && action === '/config') {
				const body = await readBody(req);
				const patch = {};
				for (const key of ['appKeyId', 'appKey', 'bucket', 'cloudFile', 'password']) {
					const value = typeof body?.[key] === 'string' ? body[key].trim() : '';
					// 密码框留空 = 不改（前端回显的是打码值，不能拿它覆盖真密码）。
					if (key === 'password' && value === '') continue;
					if (key === 'cloudFile') {
						const clean = sanitizeName(value);
						if (clean === '') continue;
						patch.cloudFile = clean;
						continue;
					}
					if (value !== '') patch[key] = value;
				}
				const next = saveConfig(patch);
				const missing = missingFields(next);
				if (missing.length === 0) {
					await bridge?.reload?.();
					log(`配置已更新（通道 ${next.channel?.channelId}）`);
				}
				json(res, 200, {
					ok: true,
					missing,
					status: bridge?.status?.() ?? {},
					message: missing.length === 0 ? '已保存，桥已重载' : `还差：${missing.join(' / ')}`,
				});
				return;
			}

			if (req.method === 'POST' && action === '/test') {
				const result = await selfTest(loadConfig());
				json(res, 200, result);
				return;
			}

			if (req.method === 'POST' && action === '/unbind') {
				const cfg = loadConfig();
				if (missingFields(cfg).length > 0 || cfg.channel === null) {
					json(res, 200, { ok: false, message: '配置不完整，无法定位通道' });
					return;
				}
				const client = new B2Client(cfg, () => {});
				const box = new Mailbox({ client, channel: cfg.channel, password: cfg.password, pack: packJson, unpack: unpackJson });
				const n = await box.wipe();
				json(res, 200, { ok: true, message: `已清空桶内 ${n} 个对象（通道 ${cfg.channel.channelId}）` });
				return;
			}

			json(res, 404, { ok: false, message: 'unknown action' });
		} catch (error) {
			log(`设置接口出错：${String(error?.message ?? error)}`);
			json(res, 200, { ok: false, message: String(error?.message ?? error) });
		}
	}
}

/** 设置页（自包含，无外部资源；配色对齐手机端设置的深色卡片风格）。 */
const PAGE = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>DSH 远程控制 · 设置</title>
<style>
  :root{--bg:#141414;--card:#1d1d1f;--line:#2c2c2e;--fg:#f2f2f7;--dim:#9a9aa0;--accent:#3d7dff;--ok:#31c46b;--warn:#e5a13a;--bad:#e5484d}
  @media (prefers-color-scheme:light){:root{--bg:#f5f5f7;--card:#fff;--line:#e3e3e6;--fg:#1c1c1e;--dim:#6b6b70}}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.55 -apple-system,"Segoe UI",system-ui,"Microsoft YaHei",sans-serif}
  .wrap{max-width:720px;margin:0 auto;padding:24px 16px 64px}
  h1{font-size:19px;margin:0 0 4px}
  .sub{color:var(--dim);font-size:12.5px;margin-bottom:18px}
  .card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:16px;margin-bottom:14px}
  .card h2{font-size:14px;margin:0 0 12px;display:flex;justify-content:space-between;align-items:center}
  .pill{font-size:11px;padding:2px 8px;border-radius:99px;border:1px solid var(--line);color:var(--dim)}
  .pill.ok{color:var(--ok);border-color:rgba(49,196,107,.4)}
  .pill.bad{color:var(--bad);border-color:rgba(229,72,77,.4)}
  label{display:block;font-size:12.5px;color:var(--dim);margin:12px 0 6px}
  input{width:100%;padding:10px 12px;border-radius:10px;border:1px solid var(--line);background:transparent;color:var(--fg);font-size:14px;outline:none}
  input:focus{border-color:var(--accent)}
  .hint{font-size:11.5px;color:var(--dim);margin-top:6px}
  .row{display:flex;gap:10px;flex-wrap:wrap;margin-top:16px}
  button{padding:10px 16px;border-radius:10px;border:1px solid var(--line);background:transparent;color:var(--fg);font-size:13.5px;cursor:pointer}
  button.primary{background:var(--accent);border-color:var(--accent);color:#fff}
  button:disabled{opacity:.5;cursor:default}
  dl{display:grid;grid-template-columns:auto 1fr;gap:6px 14px;font-size:12.5px;margin:0}
  dt{color:var(--dim)}
  dd{margin:0;font-family:ui-monospace,Consolas,monospace;word-break:break-all}
  #msg{margin-top:12px;font-size:12.5px;min-height:18px}
  .warnbox{color:var(--warn);font-size:12px;margin-top:10px}
</style></head><body><div class="wrap">
  <h1>DSH 远程控制</h1>
  <div class="sub">电脑端 · 手机 APK 通过 Backblaze B2 上的加密 7z 邮箱连接本机 DSH</div>

  <div class="card">
    <h2>同步后端 <span id="statePill" class="pill">检测中</span></h2>
    <div class="hint">填齐下面五项即自动启用真实 Backblaze B2；每一项都只保存在本机，不会上传到任何地方。</div>

    <label>Application Key ID</label>
    <input id="appKeyId" placeholder="005f0000000000000000000aa" autocomplete="off" spellcheck="false">

    <label>Application Key</label>
    <input id="appKey" type="password" placeholder="留空表示不修改" autocomplete="off" spellcheck="false">

    <label>Bucket 名称</label>
    <input id="bucket" placeholder="my-dsh-bucket" autocomplete="off" spellcheck="false">

    <label>云端文件名（= 哪台电脑）</label>
    <input id="cloudFile" placeholder="默认用本机电脑名" autocomplete="off" spellcheck="false">
    <div class="hint">
      这一项决定通道：<b>两台电脑只要这一项不同，就是两条互不干扰的通道</b>，其余四项可以完全一样。
      留空时默认用本机电脑名派生（例如 <code>desk-win</code>）；中文机器名会退化成 <code>desk-3f9a2c</code> 这种短名，建议自己改成好记的。
      手机端填同一串即可。
    </div>

    <label>加密密码（7z）</label>
    <input id="password" type="password" placeholder="留空表示不修改" autocomplete="new-password">
    <div class="hint">每个上传的 7z 都用它做 AES-256 加密；电脑端与手机端必须完全一致（区分大小写与空格）。</div>

    <div class="warnbox">⚠️ 凭据只保存在本机 $DSH_HOME/dsh-remote/config.json（权限 0600）。B2 的 Master Application Key 不支持 Native API 上传，请另建一把「限定 bucket、Read and Write」的 Application Key。</div>

    <div class="row">
      <button class="primary" id="save">保存设置</button>
      <button id="test">测试往返</button>
      <button id="unbind">清空通道</button>
    </div>
    <div id="msg"></div>
  </div>

  <div class="card">
    <h2>运行状态</h2>
    <dl id="status"></dl>
  </div>

  <div class="card">
    <h2>怎么连手机</h2>
    <div class="hint">
      1. 去 Backblaze 建一把限定本桶的 Application Key（Read and Write）。<br>
      2. 上面五项抄到手机 App 的「配对信息」里，五项必须逐字一致。<br>
      3. 再加一台电脑时：<b>只把「云端文件名」换成那台机器自己的</b>，其余四项照旧，
         两边各自独立、互不抢消息。<br>
      4. 手机点「连接」，本页「手机最后在线」开始跳动即配对成功 —— 没有配对码、没有二维码。
    </div>
  </div>
</div>
<script>
const $ = (id) => document.getElementById(id);
const esc = (v) => String(v ?? '').replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));

/*
 * 轮询每 5 秒会把 /state 回填到输入框 —— 用户正在输入时不能动，否则
 * 一长串 Key ID 打到一半就被“还原”了（以前真会这样）。所以记住哪些框
 * 已经被改过，改过的就不再回填，直到保存成功。
 */
const dirty = new Set();
for (const id of ['appKeyId', 'bucket', 'cloudFile']) {
  $(id).addEventListener('input', () => dirty.add(id));
}
function restore(id, value) {
  if (dirty.has(id)) return;
  const el = $(id);
  if (document.activeElement === el) return;
  el.value = value;
}

async function load() {
  const r = await fetch('${ROUTE}/state').then((x) => x.json());
  const c = r.config ?? {};
  restore('appKeyId', c.appKeyId ?? '');
  restore('bucket', c.bucket ?? '');
  // 没填过就预填「本机机器名派生出来的短名」：每台电脑默认自己一个名字，
  // 不会两台机器撞进同一条队列；用户想改随时改。
  restore('cloudFile', c.cloudFile || r.suggestedCloudFile || '');
  $('appKey').placeholder = c.appKeySet ? ('已保存 ' + c.appKey + '（留空不改）') : '输入 Application Key';
  $('password').placeholder = c.passwordSet ? ('已保存 ' + c.passwordMask + '（留空不改）') : '输入 7z 加密密码';
  const s = r.status ?? {};
  const pill = $('statePill');
  const ready = r.missing.length === 0 && s.running;
  pill.textContent = ready ? '已启用' : (r.missing.length ? '待填写' : '未运行');
  pill.className = 'pill ' + (ready ? 'ok' : 'bad');
  const rows = [
    ['通道 ID', s.channel || '—'],
    ['通道指纹', s.fingerprint || '—'],
    ['桶内前缀', s.root || '—'],
    ['7z 可执行文件', s.sevenZip || '—'],
    ['手机最后在线', s.lastAppSeenAt ? new Date(s.lastAppSeenAt).toLocaleString() : '还没连过'],
    ['收发计数', 'in ' + ((s.stats&&s.stats.inFrames)||0) + ' 帧 / out ' + ((s.stats&&s.stats.outFrames)||0) + ' 帧'],
    ['最近错误', s.lastError || '无'],
  ];
  $('status').innerHTML = rows.map(([k, v]) => '<dt>' + esc(k) + '</dt><dd>' + esc(v) + '</dd>').join('');
  if (r.missing.length) say('还差：' + r.missing.join(' / '), 'warn');
}

function say(text, kind) {
  $('msg').textContent = text || '';
  $('msg').style.color = kind === 'ok' ? 'var(--ok)' : kind === 'warn' ? 'var(--warn)' : kind === 'bad' ? 'var(--bad)' : '';
}

async function post(path, body) {
  return fetch('${ROUTE}' + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) }).then((x) => x.json());
}

$('save').onclick = async () => {
  $('save').disabled = true;
  try {
    const r = await post('/config', {
      appKeyId: $('appKeyId').value, appKey: $('appKey').value,
      bucket: $('bucket').value, cloudFile: $('cloudFile').value, password: $('password').value,
    });
    say(r.message ?? '已保存', r.ok ? 'ok' : 'warn');
    $('appKey').value = ''; $('password').value = '';
    dirty.clear();
    await load();
  } finally { $('save').disabled = false; }
};

$('test').onclick = async () => {
  $('test').disabled = true;
  say('正在用当前配置跑一次真实往返…');
  try {
    const r = await post('/test');
    say((r.ok ? '✅ ' : '❌ ') + (r.message ?? '') + (r.ms ? '（' + r.ms + 'ms）' : ''), r.ok ? 'ok' : 'bad');
    await load();
  } finally { $('test').disabled = false; }
};

$('unbind').onclick = async () => {
  if (!confirm('清空这条通道在桶里的所有对象？手机端会立刻断开。')) return;
  $('unbind').disabled = true;
  try {
    const r = await post('/unbind');
    say(r.message ?? '', r.ok ? 'ok' : 'bad');
  } finally { $('unbind').disabled = false; }
};

load();
setInterval(load, 5000);
</script></body></html>`;

export { ROUTE as SETTINGS_ROUTE };
