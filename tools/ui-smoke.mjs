/**
 * 界面脚本冒烟测试 —— 在 Node 里把 `assets/index.html` 的 JS 真跑一遍。
 *
 * 为什么值得写：APK 里的界面是 700 行原生 JS，没有构建期类型检查、没有
 * 单测覆盖，一旦某个 `$('id')` 拼错或者函数名写漏，表现是**装到手机上白屏**
 * —— 这是最难排查、也最容易漏的一类错误（本机没有模拟器可跑）。
 *
 * 做法：从 HTML 里抽出 `<script>`，配一套够用的 DOM 桩，在 `node:vm` 里执行，
 * 然后模拟原生的三条回调（状态推送 / 链路事件 / 审批帧），断言渲染结果。
 *
 *   node tools/ui-smoke.mjs
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import vm from 'node:vm';

const ROOT = resolve(import.meta.dirname, '..');
const HTML_PATH = join(ROOT, 'android', 'app', 'src', 'main', 'assets', 'index.html');
const html = readFileSync(HTML_PATH, 'utf8');

const results = [];
function ok(name, extra = '') {
	results.push({ name, pass: true });
	console.log(`  ✅ ${name}${extra ? `  ${extra}` : ''}`);
}
function bad(name, error) {
	results.push({ name, pass: false, error: String(error?.message ?? error) });
	console.log(`  ❌ ${name}  ${String(error?.message ?? error)}`);
}
function check(name, fn) {
	try {
		const extra = fn();
		ok(name, typeof extra === 'string' ? extra : '');
	} catch (error) {
		bad(name, error);
	}
}
function assert(condition, message) {
	if (!condition) throw new Error(message);
}

// ---------------------------------------------------------------- DOM 桩

/** 页面里所有 `id="..."` —— 桩只造这些，缺一个就说明 JS 引用了不存在的元素。 */
const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);

function makeElement(id) {
	const classes = new Set();
	const element = {
		id,
		value: '',
		placeholder: '',
		textContent: '',
		className: '',
		hidden: false,
		disabled: false,
		checked: false,
		style: {},
		dataset: {},
		scrollTop: 0,
		scrollHeight: 100,
		clientHeight: 100,
		offsetHeight: 100,
		listeners: new Map(),
		children: [],
		classList: {
			add: (name) => classes.add(name),
			remove: (name) => classes.delete(name),
			contains: (name) => classes.has(name),
			toggle: (name, force) => (force === false ? classes.delete(name) : classes.add(name)),
		},
		_addListenerNames: () => [...classes].join(' '),
		addEventListener(type, fn) {
			if (!this.listeners.has(type)) this.listeners.set(type, []);
			this.listeners.get(type).push(fn);
		},
		removeEventListener() {},
		fire(type, event = {}) {
			for (const fn of this.listeners.get(type) ?? []) fn(event);
		},
		appendChild(child) {
			this.children.push(child);
			return child;
		},
		removeChild(child) {
			this.children = this.children.filter((c) => c !== child);
			return child;
		},
		querySelectorAll: () => [],
		querySelector: () => null,
		select() {},
		focus() {},
		blur() {},
	};
	/*
	 * innerHTML 用访问器：界面里 `sel.innerHTML = ''` 就是「清空下拉」的意思，
	 * 桩里必须跟着把 children 也清掉 —— 否则第二次渲染会越挂越多，把
	 * 「下拉里有几台电脑」的断言搅乱。
	 */
	let html = '';
	Object.defineProperty(element, 'innerHTML', {
		get: () => html,
		set: (value) => {
			html = String(value ?? '');
			if (html === '') element.children = [];
		},
	});
	return element;
}

const elements = new Map();
for (const id of ids) elements.set(id, makeElement(id));

const document = {
	activeElement: null,
	body: makeElement('body'),
	getElementById: (id) => elements.get(id) ?? null,
	querySelectorAll: () => [],
	querySelector: () => null,
	createElement: (tag) => makeElement(`<${tag}>`),
	execCommand: () => true,
	addEventListener: () => {},
};

// ---------------------------------------------------------------- 原生桩

const calls = [];
const sandbox = {
	document,
	console,
	// `unref()`：界面里 toast 会挂 2.4s 的定时器，不加这个 Node 会因为
	// 「还有待触发的定时器」而一直等进程退出（整轮测试白等 40 秒）
	setTimeout: (fn, ms) => {
		const timer = setTimeout(fn, ms);
		timer.unref?.();
		return timer;
	},
	clearTimeout,
	setInterval: () => 0,
	clearInterval: () => {},
	innerHeight: 800,
	Android: {
		invoke: (id, method, args) => calls.push({ id, method, args: JSON.parse(args || '{}') }),
		ready: () => calls.push({ id: '', method: 'ready', args: {} }),
		log: () => {},
	},
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

// ---------------------------------------------------------------- 抽脚本

const scriptAt = html.indexOf('<script>');
const scriptEnd = html.lastIndexOf('</script>');
assert(scriptAt > 0 && scriptEnd > scriptAt, 'HTML 里找不到 <script> 块');
const script = html.slice(scriptAt + '<script>'.length, scriptEnd);

let bootError = null;
try {
	vm.runInContext(script, sandbox, { filename: 'index.html<script>' });
} catch (error) {
	bootError = error;
}

// ---------------------------------------------------------------- 断言

console.log('== 界面脚本冒烟 ==');
console.log(`  脚本       ${script.split('\n').length} 行 / 元素 ${ids.length} 个`);

check('脚本能完整执行（无语法错误、无未定义引用）', () => {
	if (bootError !== null) throw bootError;
	return '已执行到 boot()';
});

check('启动时向原生要了一次状态', () => {
	assert(calls.some((c) => c.method === 'ready'), '没有调用 Android.ready()');
	return `${calls.length} 次调用`;
});

check('状态推送能填好表单与状态栏', () => {
	sandbox.__nativeResult('', JSON.stringify({
		config: {
			appKeyId: '005f-test',
			bucket: 'my-dsh-bucket',
			cloudFile: 'dsh-remote',
			hasAppKey: true,
			hasPassword: true,
			channel: 'abc123def456',
			fingerprint: '8fdb70c5',
			missing: [],
		},
		link: { connected: true, message: '已连接', lastDeskSeenAt: Date.now(), lastError: '' },
		running: true,
		logs: ['已装载通道', 'B2 授权成功'],
	}));
	assert(elements.get('v-channel').textContent === 'abc123def456', '通道没填上');
	assert(elements.get('f-keyid').value === '005f-test', '表单没填上');
	assert(elements.get('v-link').textContent.includes('已连接'), '状态文案不对');
	assert(elements.get('logs').textContent.includes('B2 授权成功'), '日志没渲染');
	assert(elements.get('titleText').textContent.includes('已连接'), '标题没更新');
	return `通道 ${elements.get('v-channel').textContent}`;
});

check('聊天帧能画成气泡（含工具名与流式增量）', () => {
	sandbox.__nativeEvent('frame', JSON.stringify({
		kind: 'ev',
		sessionId: 'session-1',
		items: [
			{ op: 'add', role: 'user', text: '电脑上的第一条问题' },
			{ op: 'add', role: 'assistant', text: '这是电脑端渲染好的回答。', tools: ['pwsh'] },
			{ op: 'tool', name: 'pwsh' },
			{ op: 'live', text: '流式增量' },
			{ op: 'busy', busy: true },
		],
	}));
	const painted = elements.get('bubbles').innerHTML;
	assert(painted.includes('电脑上的第一条问题'), '用户气泡缺失');
	assert(painted.includes('渲染好的回答'), '助手气泡缺失');
	assert(painted.includes('bubble user'), '用户气泡样式不对');
	assert(painted.includes('流式增量'), '流式增量缺失');
	assert(painted.includes('tool-line'), '工具行缺失');
	assert(painted.includes('电脑正在处理'), '忙碌状态缺失');
	assert(elements.get('btnCancel').hidden === false, '停止按钮没出现');
	return `${painted.length} 字节 HTML`;
});

check('用户文本被转义（不会注入 HTML）', () => {
	sandbox.__nativeEvent('frame', JSON.stringify({
		kind: 'ev',
		sessionId: 'session-1',
		items: [{ op: 'add', role: 'user', text: '<img src=x onerror=alert(1)>' }],
	}));
	const painted = elements.get('bubbles').innerHTML;
	assert(!painted.includes('<img'), '尖括号没转义');
	assert(painted.includes('&lt;img'), '转义结果不对');
	return '已转义为 &lt;img';
});

check('审批帧能弹出选项并回调原生', () => {
	sandbox.__nativeEvent('frame', JSON.stringify({
		kind: 'ask',
		requestId: 'ask-1',
		askKind: 'approval',
		sessionId: 'session-1',
		payload: { question: '允许运行 pwsh 吗？', options: ['allowed-once', 'rejected'] },
	}));
	assert(elements.get('askModal').hidden === false, '弹层没出现');
	assert(elements.get('askText').textContent.includes('允许运行'), '问题没显示');
	const buttons = elements.get('askOptions').children;
	assert(buttons.length === 2, `选项数 ${buttons.length}（应为 2）`);
	assert(buttons[0].textContent === '允许一次', `选项文案是「${buttons[0].textContent}」`);
	return `${buttons.length} 个选项`;
});

check('心跳帧只更新在线状态，不刷气泡', () => {
	const before = elements.get('bubbles').innerHTML;
	sandbox.__nativeEvent('frame', JSON.stringify({ kind: 'hb', at: Date.now(), host: 'DESKTOP' }));
	const after = elements.get('bubbles').innerHTML;
	assert(before === after, '心跳把气泡重画了');
	return '未重画';
});

check('日志事件会追加到日志区（有上限）', () => {
	for (let i = 0; i < 400; i += 1) sandbox.__nativeEvent('log', JSON.stringify({ text: `line ${i}` }));
	const text = elements.get('logs').textContent;
	assert(text.includes('line 399'), '最后一条日志没显示');
	assert(text.split('\n').length <= 300, `日志行数 ${text.split('\n').length} 超过上限`);
	return `${text.split('\n').length} 行（上限 300）`;
});

check('返回键：连接页返回 false（交给系统），会话页返回 true', () => {
	assert(sandbox.__onBack() === false, '连接页不该拦截返回键');
	elements.get('btnGear').fire('click'); // 进列表
	const handled = sandbox.__onBack();
	assert(handled === true, '列表页应该拦截返回键');
	return '行为正确';
});

check('保存按钮会带上 5 个字段调用原生', () => {
	elements.get('f-keyid').value = 'k1';
	elements.get('f-appkey').value = 'secret';
	elements.get('f-bucket').value = 'b1';
	elements.get('f-cloud').value = 'c1';
	elements.get('f-pwd').value = 'p1';
	elements.get('btnSave').fire('click');
	const saved = calls.filter((c) => c.method === 'save').pop();
	assert(saved !== undefined, '没有调用 save');
	assert(saved.args.appKeyId === 'k1' && saved.args.appKey === 'secret', '字段没带全');
	assert(saved.args.bucket === 'b1' && saved.args.cloudFile === 'c1' && saved.args.password === 'p1', '字段没带全');
	return JSON.stringify(Object.keys(saved.args));
});

check('测试往返按钮会调用原生 test', () => {
	elements.get('btnTest').fire('click');
	assert(calls.some((c) => c.method === 'test'), '没有调用 test');
	return '已调用';
});

check('多电脑：下拉列出全部档案、选中当前那台、未配置的标出来', () => {
	sandbox.__nativeResult('', JSON.stringify({
		config: {
			appKeyId: '', bucket: '', cloudFile: '', hasAppKey: false, hasPassword: false,
			channel: '', fingerprint: '', missing: ['Application Key'],
		},
		profiles: {
			active: 'p2',
			list: [
				{ id: 'p1', name: '书房台式机', cloudFile: 'desk-win', channel: 'aaa111', complete: true, missing: [] },
				{ id: 'p2', name: '笔记本', cloudFile: 'laptop', channel: '', complete: false, missing: ['Application Key'] },
			],
		},
		link: { connected: false, message: '未配置', lastDeskSeenAt: 0, lastError: '' },
		running: false,
		logs: [],
	}));
	const sel = elements.get('f-computer');
	assert(sel.children.length === 2, `下拉里只有 ${sel.children.length} 台`);
	assert(sel.value === 'p2', '没选中当前电脑');
	assert(sel.children[1].textContent.includes('待配置'), '未配置的档案没标注');
	assert(elements.get('v-computer').textContent.includes('笔记本'), '状态卡没显示当前电脑');
	return `${sel.children.length} 台，当前「${sel.children[1].textContent}」`;
});

check('切电脑会调 profileSelect 并带上 id', () => {
	const sel = elements.get('f-computer');
	sel.value = 'p1';
	sel.fire('change');
	const switched = calls.filter((c) => c.method === 'profileSelect').pop();
	assert(switched !== undefined, '没有调用 profileSelect');
	assert(switched.args.id === 'p1', `id 是 ${switched.args.id}`);
	return `id=${switched.args.id}`;
});

check('新增电脑：弹命名层，确定后调 profileNew', () => {
	elements.get('btnAddComputer').fire('click');
	assert(elements.get('nameModal').hidden === false, '命名层没弹出来');
	elements.get('nameInput').value = '客厅小主机';
	elements.get('nameOk').fire('click');
	const created = calls.filter((c) => c.method === 'profileNew').pop();
	assert(created !== undefined, '没有调用 profileNew');
	assert(created.args.name === '客厅小主机', `名字是「${created.args.name}」`);
	assert(elements.get('nameModal').hidden === true, '命名层没关掉');
	return created.args.name;
});

check('删除电脑要连点两次（不会误删）', () => {
	const btn = elements.get('btnDelComputer');
	btn.fire('click');
	assert(calls.filter((c) => c.method === 'profileDelete').length === 0, '第一次点击就删了');
	assert(btn.textContent === '确认删除？', `按钮文案是「${btn.textContent}」`);
	btn.fire('click');
	assert(calls.filter((c) => c.method === 'profileDelete').length === 1, '第二次点击没执行');
	return '两次确认';
});

check('不依赖 confirm()/prompt()（WebView 没有 WebChromeClient 会直接取消）', () => {
	// 只查代码，不查注释 —— 注释里正是在解释「为什么不用它们」
	const code = script.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
	assert(!/\bconfirm\s*\(/.test(code), '代码里还在用 confirm()');
	assert(!/\bprompt\s*\(/.test(code), '代码里还在用 prompt()');
	return '危险操作改用自绘弹层 + 连点两次';
});

check('所有事件监听都挂在真实存在的元素上', () => {
	for (const id of ['btnBack', 'btnGear', 'btnSave', 'btnTest', 'btnReconnect', 'btnStop', 'btnUnbind',
		'btnCopyLogs', 'btnRefresh', 'btnSend', 'btnCancel', 'askClose', 'input',
		'f-computer', 'btnAddComputer', 'btnRenameComputer', 'btnDelComputer', 'nameOk', 'nameCancel']) {
		const element = elements.get(id);
		assert(element !== undefined, `元素 #${id} 不存在`);
		assert(element.listeners.size > 0, `#${id} 没有绑定任何事件`);
	}
	return '19 个入口全部绑定';
});

const passed = results.filter((r) => r.pass).length;
console.log(`\n== 结果：${passed}/${results.length} 通过 ==`);
if (passed !== results.length) {
	for (const r of results.filter((x) => !x.pass)) console.log(`  ❌ ${r.name}: ${r.error}`);
	process.exitCode = 1;
}
