package dshremote.ui;

import android.os.Handler;
import android.os.Looper;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import dshremote.B2Client;
import dshremote.Config;
import dshremote.Json;
import dshremote.Profiles;
import dshremote.RemoteLink;
import dshremote.SelfTest;

/**
 * 界面与原生之间的唯一一层胶水（`WebView` 里的 `window.Android`）。
 *
 * ## 为什么是异步的
 *
 * 所有真正干活的事情（B2 授权、上传、等电脑应答）都是网络 I/O，一次几百
 * 毫秒到十几秒。如果 JS 直接同步调用，WebView 的主线程会被卡住 —— 连
 * 「请稍候」都渲染不出来。所以约定成：
 *
 * ```js
 *   Android.invoke(id, 'threads', '{}')      // 立刻返回
 *   window.__nativeResult(id, '{"ok":true}') // 好了再回调
 * ```
 *
 * ## 线程模型
 *
 * ```
 *   JS 线程  → invoke() 只把任务丢进单线程池，立刻返回
 *   工作线程 → handle()：可能阻塞（网络），所以必须离开主线程
 *   主线程   → evaluateJavascript 回调 JS（WebView 只许在它自己的线程上碰）
 * ```
 *
 * 单线程池是刻意的：同一个通道上并发跑两次列举没有好处，而且能让「等应答」
 * 的调用自然排队，日志顺序也和用户操作顺序一致。
 */
public final class UiBridge implements LinkService.Listener {

    private static final int LOG_LIMIT = 300;

    private final MainActivity activity;
    private final WebView webView;
    private final Handler ui = new Handler(Looper.getMainLooper());
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final ArrayDeque<String> logs = new ArrayDeque<>();

    private final B2Client.Log logger = new B2Client.Log() {
        @Override
        public void log(String message) {
            onLog(message);
        }
    };

    public UiBridge(MainActivity activity, WebView webView) {
        this.activity = activity;
        this.webView = webView;
    }

    // ---------------------------------------------------------------- JS 入口

    @JavascriptInterface
    public void invoke(final String id, final String method, final String argsJson) {
        worker.execute(new Runnable() {
            @Override
            public void run() {
                Map<String, Object> payload;
                try {
                    payload = handle(method, parseArgs(argsJson));
                } catch (Throwable error) {
                    payload = new LinkedHashMap<>();
                    payload.put("ok", false);
                    payload.put("error", message(error));
                    onLog("✗ " + method + "：" + message(error));
                }
                reply(id, payload);
            }
        });
    }

    /** 页面加载完时补一次状态，免得界面先闪一下「未连接」。 */
    @JavascriptInterface
    public void ready() {
        worker.execute(() -> reply("", state()));
    }

    @JavascriptInterface
    public void log(final String text) {
        // 只用于把 JS 侧的异常捞到原生日志里，方便真机排查
        onLog("[ui] " + text);
    }

    // ---------------------------------------------------------------- 方法表

    private Map<String, Object> handle(String method, Map<String, Object> args) throws Exception {
        switch (method == null ? "" : method) {
            case "state":
                return state();

            case "save":
                return save(args);

            case "test":
                return wrap(SelfTest.run(service().config(), logger));

            case "unbind": {
                int deleted = SelfTest.wipe(service().config(), logger);
                service().restartLink();
                Map<String, Object> out = new LinkedHashMap<>();
                out.put("ok", true);
                out.put("deleted", deleted);
                return out;
            }

            case "linkStart":
                service().ensureLink();
                return ok();

            case "linkStop":
                service().stopLink();
                return ok();

            /*
             * 多电脑：增 / 切 / 改名 / 删。
             *
             * 每个动作都以 restartLink() 收尾 —— 切电脑必须把旧链路彻底拆掉，
             * 否则两条链路会同时轮询两条队列，游标各写各的，消息就开始乱跑。
             */
            case "profileNew":
            case "profileSelect":
            case "profileRename":
            case "profileDelete":
                return profileAction(method, args);

            case "logs": {
                Map<String, Object> out = new LinkedHashMap<>();
                out.put("ok", true);
                out.put("lines", recentLogs(LOG_LIMIT));
                return out;
            }

            case "threads":
                return wrap(linkCall("app/threads", args, 30_000));

            case "thread":
                return wrap(linkCall("app/thread", args, 30_000));

            case "send":
                return wrap(linkCall("app/send", args, 30_000));

            case "cancel":
                return wrap(linkCall("app/cancel", args, 30_000));

            case "answer":
                return wrap(linkCall("app/answer", args, 30_000));

            case "pending":
                return wrap(linkCall("app/pending", args, 30_000));

            case "newthread":
                return wrap(linkCall("app/newthread", args, 30_000));

            case "ping":
                return wrap(linkCall("app/ping", args, 20_000));

            /*
             * 订阅不是一次 RPC，是「让电脑端替我订阅 SSE」的持续状态：
             * 发一帧 ctl 给桥就行，所以直接调 RemoteLink，不经过 app/* 包装。
             */
            case "subscribe": {
                RemoteLink link = linkOrThrow();
                link.subscribe(Json.str(args, "sessionId", ""), Json.num(args, "fromSeq", -1));
                onLog("订阅会话 " + Json.str(args, "sessionId", "") + "（fromSeq=" + Json.num(args, "fromSeq", -1) + "）");
                return ok();
            }

            case "unsubscribe": {
                RemoteLink link = linkOrThrow();
                link.unsubscribe(Json.str(args, "sessionId", ""));
                return ok();
            }

            default:
                throw new IllegalArgumentException("未知方法 " + method);
        }
    }

    private Map<String, Object> save(Map<String, Object> args) {
        Config cfg = service().config();
        cfg.appKeyId = text(args, "appKeyId", cfg.appKeyId);
        cfg.appKey = text(args, "appKey", cfg.appKey);
        cfg.bucket = text(args, "bucket", cfg.bucket);
        cfg.cloudFile = text(args, "cloudFile", cfg.cloudFile);
        // 密码留空表示「不改」：界面上只回显掩码，用户不重输就不该被清掉
        cfg.password = text(args, "password", cfg.password);
        cfg.save(service().profiles().activeStore());
        service().restartLink();

        onLog(cfg.complete()
                ? "已保存配对信息，通道 " + cfg.channel().channelId
                : "已保存，但还差：" + String.join("、", cfg.missing()));
        // 回整份 state：档案列表里那台电脑的通道/完整度也跟着变了
        return state();
    }

    private Map<String, Object> profileAction(String method, Map<String, Object> args) {
        Profiles profiles = service().profiles();
        String id = Json.str(args, "id", "");
        String name = Json.str(args, "name", "");
        switch (method) {
            case "profileNew": {
                String created = profiles.create(name);
                Config fresh = Config.load(profiles.storeFor(created));
                onLog("新增电脑「" + profiles.nameOf(created) + "」，云端文件名默认 " + fresh.cloudFile
                        + "（这一项决定通道，照抄到那台电脑就是新机器）");
                break;
            }
            case "profileSelect":
                if (profiles.has(id)) {
                    profiles.setActive(id);
                    onLog("切到「" + profiles.nameOf(id) + "」");
                }
                break;
            case "profileRename":
                profiles.rename(id, name);
                onLog("已改名为「" + profiles.nameOf(id) + "」");
                break;
            case "profileDelete": {
                String label = profiles.nameOf(id);
                profiles.remove(id);
                onLog("已删除电脑「" + label + "」");
                break;
            }
            default:
                throw new IllegalArgumentException("未知动作 " + method);
        }
        service().restartLink();
        return state();
    }

    private Map<String, Object> state() {
        Config cfg = service().config();
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("ok", true);
        out.put("config", cfg.toMap(true));

        RemoteLink link = service().link();
        if (link == null) {
            Map<String, Object> idle = new LinkedHashMap<>();
            idle.put("connected", false);
            idle.put("message", cfg.complete() ? "链路未启动" : "未配置");
            idle.put("lastDeskSeenAt", 0L);
            idle.put("lastError", "");
            out.put("link", idle);
            out.put("running", false);
        } else {
            out.put("link", link.state().toMap());
            out.put("running", link.isRunning());
        }
        out.put("logs", recentLogs(LOG_LIMIT));
        out.put("profiles", profilesPayload());
        return out;
    }

    /**
     * 「电脑」下拉需要的最小信息：名字、通道、还差几项。
     *
     * 不返回 appKey / 密码 —— 界面只是切换用，没有任何理由把密钥再往 JS 里送一次。
     */
    private Map<String, Object> profilesPayload() {
        Profiles profiles = service().profiles();
        List<Object> items = new ArrayList<>();
        for (Profiles.Item item : profiles.list()) {
            Config cfg = Config.load(profiles.storeFor(item.id));
            Config.Channel channel = cfg.channel();
            Map<String, Object> one = new LinkedHashMap<>();
            one.put("id", item.id);
            one.put("name", item.name);
            one.put("cloudFile", cfg.cloudFile);
            one.put("channel", channel == null ? "" : channel.channelId);
            one.put("complete", cfg.complete());
            one.put("missing", cfg.missing());
            items.add(one);
        }
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("active", profiles.activeId());
        out.put("list", items);
        return out;
    }

    private Map<String, Object> linkCall(String method, Map<String, Object> args, long timeoutMs) throws Exception {
        return linkOrThrow().call(method, args, timeoutMs);
    }

    private RemoteLink linkOrThrow() {
        RemoteLink link = service().link();
        if (link == null) throw new IllegalStateException("链路未启动：先保存配对信息");
        return link;
    }

    // ---------------------------------------------------------------- 事件

    @Override
    public void onFrame(Map<String, Object> frame) {
        emit("frame", frame);
    }

    @Override
    public void onState(RemoteLink.State state) {
        emit("state", state.toMap());
    }

    @Override
    public void onLog(String message) {
        synchronized (logs) {
            logs.addLast(message);
            while (logs.size() > LOG_LIMIT) logs.removeFirst();
        }
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("text", message);
        payload.put("at", System.currentTimeMillis());
        emit("log", payload);
    }

    private List<Object> recentLogs(int limit) {
        List<Object> out = new ArrayList<>();
        synchronized (logs) {
            int skip = Math.max(0, logs.size() - limit);
            int i = 0;
            for (String line : logs) {
                if (i++ < skip) continue;
                out.add(line);
            }
        }
        return out;
    }

    // ---------------------------------------------------------------- 回传 JS

    private void reply(String id, Map<String, Object> payload) {
        if (payload == null) payload = ok();
        String json = Json.stringify(payload);
        eval("window.__nativeResult(" + Json.stringify(id == null ? "" : id) + "," + Json.stringify(json) + ")");
    }

    private void emit(String kind, Object payload) {
        String json = Json.stringify(payload);
        eval("window.__nativeEvent(" + Json.stringify(kind) + "," + Json.stringify(json) + ")");
    }

    private void eval(final String script) {
        ui.post(new Runnable() {
            @Override
            public void run() {
                try {
                    webView.evaluateJavascript(script, null);
                } catch (Throwable ignored) {
                    // 页面已销毁 / WebView 正在重建：丢掉这一帧即可，下一轮会补
                }
            }
        });
    }

    // ---------------------------------------------------------------- 小工具

    private LinkService service() {
        LinkService service = activity.service();
        if (service == null) throw new IllegalStateException("服务尚未就绪，请稍等一秒再试");
        return service;
    }

    private static Map<String, Object> wrap(Map<String, Object> data) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("ok", true);
        out.put("data", data == null ? new LinkedHashMap<String, Object>() : data);
        return out;
    }

    private static Map<String, Object> ok() {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("ok", true);
        return out;
    }

    private static Map<String, Object> parseArgs(String json) {
        if (json == null || json.trim().isEmpty()) return new LinkedHashMap<>();
        try {
            return Json.parseObject(json);
        } catch (RuntimeException error) {
            return new LinkedHashMap<>();
        }
    }

    private static String text(Map<String, Object> args, String key, String fallback) {
        String value = Json.str(args, key, null);
        if (value == null) return fallback;
        value = value.trim();
        return value.isEmpty() ? fallback : value;
    }

    private static String message(Throwable error) {
        String text = error.getMessage();
        if (text == null || text.isEmpty()) text = error.getClass().getSimpleName();
        return text;
    }
}
