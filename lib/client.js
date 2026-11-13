/**
 * dsh-remote-control-desktop —— 电脑端（client half，跑在 DSH Web GUI 的「设置」里）。
 *
 * ## 这一页只做一件事
 *
 * 把真正的配对页（`GET /api/dsh-remote-control/`，由 host 半边的 `settings.js` 提供）
 * 嵌进 DSH 的设置里，让用户不需要记 URL 也能找到那 5 个输入框。
 *
 * ## 为什么配对页不写在这里
 *
 * 因为**手机和电脑要填的是同一张表**。配对页做成独立 HTML（host 半边内嵌），
 * 有三个实在的好处：
 *
 *   1. 同一份界面能直接用浏览器打开（排障时不用启动 GUI）；
 *   2. 不依赖客户端 bundle 的版本 —— 电脑端升级 DSH 不会让配对页失效；
 *   3. 「测试往返」「清空通道」这类会真发网络请求的动作，与宿主页面解耦，
 *      出错也只是那一页报错，不会把设置面板整体打崩。
 *
 * 这里因此退化成一个 iframe + 状态摘要，几乎不会坏。
 *
 * ## 语法约束
 *
 * 与隔壁插件同样的口径：**不用**可选链 `?.`、空值合并 `??`、`Object.fromEntries`、
 * `Array.prototype.flat` 这些较新语法（客户端 bundle 的编译目标不确定，宁可保守）。
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

		/** 配对页与它的 JSON 状态（见 lib/mail7z/settings.js）。 */
		var API = '/api/dsh-remote-control';

		// ---------------------------------------------------------------- 样式
		//
		// 只声明真实存在的设计令牌：写错不会报错，会静默走 fallback，
		// 那是「看着不对劲又查不出原因」的典型来源。

		var CSS = {
			page: 'display:flex;flex-direction:column;gap:14px;padding:4px 0 24px;max-width:720px;',
			title: 'color:var(--dsw-alias-label-primary);font-size:14px;font-weight:510;line-height:22px;margin:0;',
			desc: 'color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px;margin:0;',
			hint: 'color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;margin:0;',
			row: 'display:flex;flex-wrap:wrap;align-items:center;gap:8px;',
			gap: 'flex:1 1 0;',
			frame: 'width:100%;height:640px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md,10px);background:transparent;',
			mono: 'font-family:ui-monospace,Consolas,monospace;font-size:12px;color:var(--dsw-alias-label-secondary);',
		};

		/** 读一次状态；失败也 resolve，界面统一走 `{ok:false}` 分支。 */
		function fetchState() {
			return fetch(API + '/state', { cache: 'no-store' }).then(
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

			var reload = react.useCallback(function () {
				setBusy(true);
				fetchState().then(function (payload) {
					if (payload && payload.config) {
						setState(payload);
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

			var status = (state && state.status) || {};
			var config = (state && state.config) || {};
			var missing = (state && state.missing) || [];
			var running = status.running === true;

			var head = h(
				'div',
				{ style: CSS.row },
				pill(running ? '通道运行中' : '通道未运行', running),
				h('span', { style: CSS.gap }),
				h(
					Button,
					{ variant: 'ghost', size: 'sm', onClick: reload, disabled: busy },
					busy ? '刷新中…' : '刷新状态',
				),
			);

			var summary = missing.length > 0
				? h('p', { style: CSS.desc }, '还差 ' + missing.length + ' 项没填：' + missing.join(' / '))
				: h(
					'p',
					{ style: CSS.mono },
					'通道 ' + (status.channel || config.channel || '—') +
					'　指纹 ' + (status.fingerprint || config.fingerprint || '—') +
					'　桶 ' + (status.bucket || config.bucket || '—') +
					'　云端文件 ' + (status.cloudFile || config.cloudFile || '—'),
				);

			// iframe 是这一页的主体：配对表单、测试往返、清空通道都在里面
			var frame = h('iframe', {
				src: API + '/',
				style: CSS.frame,
				title: 'DSH 远程控制 · 连接设置',
			});

			var footer = h(
				'div',
				{ style: CSS.row },
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
				h(
					'span',
					{ style: CSS.hint },
					'手机 App 里填同样 5 项就能连上；数据都是加密包，桶里看不到明文。',
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
			];

			if (error !== '') {
				children.push(h('p', { style: CSS.desc }, '⚠️ ' + error));
			}
			children.push(frame, footer);

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
