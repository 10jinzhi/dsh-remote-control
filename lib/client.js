/**
 * dsh-remote-control-desktop —— 电脑端（client half，跑在 DSH Web GUI 的「设置」里）。
 *
 * ## 配对面板为什么直接渲染，而不是嵌一个 iframe
 *
 * 早期版本把 host 侧那份自包含 HTML（`GET /api/dsh-remote-control/`）用 iframe
 * 嵌进来，结果是**一片空白** —— 而且完全不产生错误日志。原因有三层：
 *
 *   1. React 的 `style` prop 只接受对象。原来把 `'display:flex;...'` 这种 CSS
 *      字符串直接传进去，样式全丢（生产构建里连警告都没有）。
 *   2. DSH 桌面端的页面 origin 是 `dsh-app://app`，前端 CSP 的 `frame-src`
 *      对自定义 scheme 并不友好，iframe 里的相对路径请求很容易被拦成空白。
 *   3. iframe 高度固定 640px，一旦加载失败就只是一块留白，用户看不出是
 *      「没加载」还是「没有配置项」。
 *
 * 现在改成原生表单 + `fetch`：请求走 DSH 自己的同源代理（`dsh-app://app/api/...`
 * 会被主进程带 cookie 转发给 host），字段与 host 侧 `/state` 一一对应。
 * 独立 HTML 页仍保留（host 侧 `GET /api/dsh-remote-control/`），排障时可以直接
 * 用浏览器打开，但 GUI 里不再依赖它。
 *
 * ## 语法约束
 *
 * **不用**可选链 `?.`、空值合并 `??`、`Object.fromEntries`、`Array.prototype.flat`
 * 这些较新语法（客户端 bundle 的编译目标不确定，宁可保守）。
 *
 * @module dsh-remote-control-desktop/client
 */

window.__ModuleLoader__.load({
	id: 'dsh-remote-control-desktop',
	factory: (require) => {
		// 官方 client bundle 的 intro 模板就是这两句（见 tsdown.client.ts 的
		// `intro`）：少写第二句，下面 `exports.apply = ...` 会在 web-boot 实例化
		// factory 时抛 `ReferenceError: exports is not defined`，整个 entry 被判
		// 「did not activate」而拖垮启动。手写客户端脚本时必须自己补齐。
		var module = { exports: {} };
		var exports = module.exports;

		var react = require('react');
		var h = react.createElement;

		var primitives = require('@deepseek-ai/dsh-client-ui-primitives');
		var Button = primitives.Button;
		var Pill = primitives.Pill;

		/** host 侧设置接口（见 lib/mail7z/settings.js）。 */
		var API = '/api/dsh-remote-control';

		// ---------------------------------------------------------------- 样式
		//
		// ⚠️ 必须是**对象**，不能是 CSS 字符串。React 的 `style` prop 只接受
		// `{ fontSize: '14px' }` 这种映射；传字符串会丢掉全部样式（生产构建里
		// 连警告都没有），面板看起来就像什么都没渲染。
		//
		// 带 px 的值统一写成字符串：React 只对少数无单位属性自动补 px，
		// lineHeight 给数字会被当成倍数，视觉上直接跑偏。

		var CSS = {
			page: {
				display: 'flex',
				flexDirection: 'column',
				gap: '14px',
				padding: '4px 0 24px',
				maxWidth: '720px',
			},
			title: {
				color: 'var(--dsw-alias-label-primary)',
				fontSize: '14px',
				fontWeight: 510,
				lineHeight: '22px',
				margin: 0,
			},
			desc: {
				color: 'var(--dsw-alias-label-secondary)',
				fontSize: '13px',
				lineHeight: '20px',
				margin: 0,
			},
			hint: {
				color: 'var(--dsw-alias-label-tertiary)',
				fontSize: '12px',
				lineHeight: '18px',
				margin: 0,
			},
			row: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '8px' },
			gap: { flex: '1 1 0' },
			mono: {
				fontFamily: 'ui-monospace,Consolas,monospace',
				fontSize: '12px',
				color: 'var(--dsw-alias-label-secondary)',
				margin: 0,
				wordBreak: 'break-all',
			},
			card: {
				display: 'flex',
				flexDirection: 'column',
				gap: '10px',
				padding: '14px',
				border: '1px solid var(--dsw-alias-border-l2)',
				borderRadius: 'var(--dsw-radius-md,10px)',
			},
			field: { display: 'flex', flexDirection: 'column', gap: '4px' },
			label: {
				color: 'var(--dsw-alias-label-secondary)',
				fontSize: '12px',
				lineHeight: '18px',
			},
			input: {
				width: '100%',
				boxSizing: 'border-box',
				padding: '8px 10px',
				border: '1px solid var(--dsw-alias-border-l2)',
				borderRadius: '8px',
				background: 'transparent',
				color: 'var(--dsw-alias-label-primary)',
				fontSize: '13px',
				lineHeight: '20px',
				outline: 'none',
			},
			ok: {
				color: 'var(--dsw-alias-label-primary)',
				fontSize: '12px',
				lineHeight: '18px',
				margin: 0,
			},
			bad: {
				color: 'var(--dsw-alias-state-error,#e5484d)',
				fontSize: '12px',
				lineHeight: '18px',
				margin: 0,
			},
		};

		/** 带 JSON 解析的请求；网络错误也 resolve，界面统一走 `{ok:false}` 分支。 */
		function fetchJson(path, init) {
			return fetch(API + path, init).then(
				function (response) {
					return response.json().then(
						function (payload) {
							return payload;
						},
						function () {
							return { ok: false, message: '宿主返回的不是 JSON（HTTP ' + response.status + '）' };
						},
					);
				},
				function (error) {
					return { ok: false, message: '连不上宿主服务：' + String((error && error.message) || error) };
				},
			);
		}

		function pill(text, active) {
			return h(Pill, active === true ? { active: true } : null, text);
		}

		// ---------------------------------------------------------------- 面板

		function RelayPanel() {
			var stateResult = react.useState(null);
			var state = stateResult[0];
			var setState = stateResult[1];

			var errorResult = react.useState('');
			var error = errorResult[0];
			var setError = errorResult[1];

			var busyResult = react.useState(false);
			var busy = busyResult[0];
			var setBusy = busyResult[1];

			var noteResult = react.useState(null);
			var note = noteResult[0];
			var setNote = noteResult[1];

			var armedResult = react.useState(false);
			var armed = armedResult[0];
			var setArmed = armedResult[1];

			var formResult = react.useState({
				appKeyId: '',
				appKey: '',
				bucket: '',
				cloudFile: '',
				password: '',
			});
			var values = formResult[0];
			var setValues = formResult[1];

			var reload = react.useCallback(function () {
				setBusy(true);
				fetchJson('/state').then(function (payload) {
					if (payload && payload.config) {
						setState(payload);
						setValues({
							appKeyId: payload.config.appKeyId || '',
							// 密钥/密码只显示打码值，输入框留空 = 不改。
							appKey: '',
							bucket: payload.config.bucket || '',
							cloudFile: payload.config.cloudFile || payload.suggestedCloudFile || '',
							password: '',
						});
						setError('');
					} else {
						setError((payload && payload.message) || '读取状态失败');
					}
					setBusy(false);
				});
			}, []);

			react.useEffect(function () {
				reload();
			}, [reload]);

			function edit(key, value) {
				setValues(function (prev) {
					var next = {
						appKeyId: prev.appKeyId,
						appKey: prev.appKey,
						bucket: prev.bucket,
						cloudFile: prev.cloudFile,
						password: prev.password,
					};
					next[key] = value;
					return next;
				});
				// 改任何字段都取消「清空通道」的待确认状态，避免误触
				setArmed(false);
			}

			function save() {
				setBusy(true);
				setNote(null);
				fetchJson('/config', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({
						appKeyId: values.appKeyId,
						appKey: values.appKey,
						bucket: values.bucket,
						cloudFile: values.cloudFile,
						password: values.password,
					}),
				}).then(function (payload) {
					setNote({
						ok: payload.ok !== false,
						text: (payload && payload.message) || '已保存',
					});
					setBusy(false);
					// 保存成功后重新读一次：打码值、missing、桥状态都会变
					reload();
				});
			}

			function runTest() {
				setBusy(true);
				setNote(null);
				fetchJson('/test', { method: 'POST' }).then(function (payload) {
					var ms = payload && payload.ms ? '（' + payload.ms + 'ms）' : '';
					setNote({
						ok: payload.ok !== false,
						text: (payload.ok === false ? '往返失败' : '往返正常') + ms + '：' + String((payload && payload.message) || ''),
					});
					setBusy(false);
				});
			}

			function wipe() {
				if (armed !== true) {
					setArmed(true);
					setNote({ ok: null, text: '再点一次「清空通道」确认：会删掉桶里这条通道的全部对象。' });
					return;
				}
				setArmed(false);
				setBusy(true);
				setNote(null);
				fetchJson('/unbind', { method: 'POST' }).then(function (payload) {
					setNote({ ok: payload.ok !== false, text: (payload && payload.message) || '已清空' });
					setBusy(false);
					reload();
				});
			}

			var status = (state && state.status) || {};
			var config = (state && state.config) || {};
			var missing = (state && state.missing) || [];
			var running = status.running === true;

			var head = h(
				'div',
				{ style: CSS.row },
				pill(running ? '通道运行中' : '通道未运行', running),
				missing.length > 0 ? pill('还差 ' + missing.length + ' 项', false) : null,
				h('span', { style: CSS.gap }),
				h(
					Button,
					{ variant: 'ghost', size: 'sm', onClick: reload, disabled: busy },
					busy ? '刷新中…' : '刷新状态',
				),
			);

			var summary = missing.length > 0
				? h('p', { style: CSS.bad }, '还差 ' + missing.length + ' 项没填：' + missing.join(' / '))
				: h(
					'p',
					{ style: CSS.mono },
					'通道 ' + (status.channel || config.channel || '—') +
					'　指纹 ' + (status.fingerprint || config.fingerprint || '—') +
					'　桶 ' + (status.bucket || config.bucket || '—') +
					'　云端文件 ' + (status.cloudFile || config.cloudFile || '—'),
				);

			function field(key, label, placeholder, secret, hint) {
				return h(
					'div',
					{ style: CSS.field },
					h('label', { style: CSS.label, htmlFor: 'dsh-remote-' + key }, label),
					h('input', {
						id: 'dsh-remote-' + key,
						style: CSS.input,
						type: secret ? 'password' : 'text',
						autoComplete: 'off',
						spellCheck: false,
						placeholder: placeholder,
						value: values[key],
						disabled: busy,
						onChange: function (event) {
							edit(key, event.target.value);
						},
					}),
					hint ? h('span', { style: CSS.hint }, hint) : null,
				);
			}

			var form = h(
				'div',
				{ style: CSS.card },
				field('appKeyId', 'Application Key ID', '例如 005f0000000000000000000aa', false, ''),
				field(
					'appKey',
					'Application Key',
					config.appKeySet ? '已保存（' + (config.appKey || '') + '），留空表示不改' : 'B2 的 applicationKey',
					true,
					'',
				),
				field('bucket', 'Bucket 名称', '例如 my-dsh-bucket', false, ''),
				field(
					'cloudFile',
					'云端文件名',
					(state && state.suggestedCloudFile) || '留空则用本机机器名',
					false,
					'它决定桶里的目录，也就是「哪台电脑」。不同电脑必须不同。',
				),
				field(
					'password',
					'加密密码',
					config.passwordSet ? '已保存（' + (config.passwordMask || '') + '），留空表示不改' : '解开 7z 包用的密码',
					true,
					'手机端填同一个密码；数据在桶里始终是 7z 加密的。',
				),
			);

			var actions = h(
				'div',
				{ style: CSS.row },
				h(Button, { variant: 'primary', size: 'sm', onClick: save, disabled: busy }, busy ? '处理中…' : '保存'),
				h(Button, { variant: 'ghost', size: 'sm', onClick: runTest, disabled: busy }, '测试往返'),
				h(
					Button,
					{ variant: 'ghost', size: 'sm', onClick: wipe, disabled: busy },
					armed === true ? '确认清空通道' : '清空通道',
				),
				h('span', { style: CSS.gap }),
				h(
					Button,
					{
						variant: 'ghost',
						size: 'sm',
						onClick: function () {
							window.open(API + '/', '_blank', 'noopener');
						},
					},
					'在新窗口打开',
				),
			);

			var children = [
				h('p', { style: CSS.title }, 'DSH 远程控制'),
				h(
					'p',
					{ style: CSS.desc },
					'手机通过 Backblaze B2 私有桶里加密的 7z 包访问本机 DSH 会话 —— 不需要配对码、不需要公网隧道、不依赖第三方服务器。',
				),
				head,
				summary,
				form,
				actions,
			];

			if (error !== '') {
				children.push(h('p', { style: CSS.bad }, '⚠️ ' + error));
			}
			if (note !== null) {
				children.push(h('p', { style: note.ok === false ? CSS.bad : CSS.ok }, (note.ok === false ? '⚠️ ' : '') + note.text));
			}
			children.push(
				h('p', { style: CSS.hint }, '手机 App 里填同样 5 项就能连上；桶里看不到明文。'),
			);

			return h('div', { style: CSS.page }, children);
		}

		// ---------------------------------------------------------------- 注册

		var SLOT = 'settings.section';
		var CELL_ID = 'dsh-remote-control-desktop';
		var inject = ['slots'];

		function apply(ctx) {
			ctx.slots.inject(SLOT, function () {
				return ctx.slots.register(
					{
						name: SLOT,
						id: CELL_ID,
						// 排在官方页面之后（与 dsh-mcp-manager 同样的取舍：不打乱官方顺序）
						order: 212,
						label: 'DSH 远程控制',
					},
					RelayPanel,
				);
			});
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});
