package dshremote;

import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 手机端核心的 JVM 端到端测试（只在开发机上跑，不进 APK）。
 *
 * 它跑的是**和 APK 里完全同一份代码**（`Config` / `B2Client` / `Mailbox` /
 * `RemoteLink` / `SevenZip*`），只是把 Android 的 SharedPreferences 换成一个
 * 文件 Store —— 这正是把这些类写成「不碰 Android API」的原因。
 *
 * 用法：java dshremote.JvmClientTest <config.json> [--subscribe]
 *
 * 输出：每行一个 JSON 结果，形如 {"check":"...","ok":true,"detail":"..."}，
 * 由 tools/e2e-app.mjs 收集断言。
 */
public final class JvmClientTest {

    private static final List<String> logs = new ArrayList<>();

    private JvmClientTest() {}

    public static void main(String[] args) throws Exception {
        if (args.length < 1) {
            System.err.println("用法：JvmClientTest <config.json> [--subscribe]");
            System.exit(2);
        }
        Path configPath = Path.of(args[0]);
        boolean subscribe = args.length > 1 && "--subscribe".equals(args[1]);

        Map<String, Object> raw = Json.parseObject(new String(Files.readAllBytes(configPath), StandardCharsets.UTF_8));
        // 测试钩子：把授权地址指向本地 B2 桩（生产环境不设置这一项）
        B2Client.setAuthorizeUrl(Json.str(raw, "authorizeUrl", ""));
        FileStore store = new FileStore(Path.of(args[0] + ".state"));
        store.put("appKeyId", Json.str(raw, "appKeyId", ""));
        store.put("appKey", Json.str(raw, "appKey", ""));
        store.put("bucket", Json.str(raw, "bucket", ""));
        store.put("cloudFile", Json.str(raw, "cloudFile", ""));
        store.put("password", Json.str(raw, "password", ""));

        Config cfg = Config.load(store);
        Config.Channel channel = cfg.channel();
        emit("channel", channel != null, channel == null ? "配置不完整" : channel.channelId + " / " + channel.fingerprint);

        final List<Map<String, Object>> frames = new ArrayList<>();
        final boolean[] connected = { false };
        final String[] lastError = { "" };
        RemoteLink link = new RemoteLink(store, new RemoteLink.Listener() {
            @Override
            public void onFrame(Map<String, Object> frame) {
                synchronized (frames) {
                    frames.add(frame);
                    frames.notifyAll();
                }
            }

            @Override
            public void onState(RemoteLink.State state) {
                connected[0] = state.connected;
                if (!state.lastError.isEmpty()) lastError[0] = state.lastError;
            }

            @Override
            public void onLog(String message) {
                synchronized (logs) {
                    logs.add(message);
                }
            }
        });

        link.start();

        // ---- 等连上（电脑端会先回一个 hb 或我们的 ping 应答）
        long deadline = System.currentTimeMillis() + 40_000;
        boolean alive = false;
        while (System.currentTimeMillis() < deadline) {
            if (connected[0]) { alive = true; break; }
            Thread.sleep(300);
        }
        emit("link-connected", alive, alive ? "已连上电脑" : ("超时 " + lastError[0]));

        long t0 = System.currentTimeMillis();
        Map<String, Object> hello = link.call("app/hello", new LinkedHashMap<String, Object>(), 30_000);
        emit("app/hello", "true".equals(String.valueOf(hello.get("ok")))
                        || Boolean.TRUE.equals(hello.get("ok")),
                "host=" + hello.get("host") + " 往返 " + (System.currentTimeMillis() - t0) + "ms");

        Map<String, Object> threads = link.call("app/threads", new LinkedHashMap<String, Object>(), 30_000);
        List<Object> workspaces = Json.arr(threads, "workspaces");
        emit("app/threads", workspaces.size() > 0, workspaces.size() + " 个工作区");

        Map<String, Object> params = new LinkedHashMap<>();
        params.put("sessionId", "session-fake-1");
        Map<String, Object> thread = link.call("app/thread", params, 30_000);
        List<Object> bubbles = Json.arr(thread, "bubbles");
        String firstText = "";
        if (bubbles.size() > 0) {
            @SuppressWarnings("unchecked")
            Map<String, Object> b0 = (Map<String, Object>) bubbles.get(0);
            firstText = Json.str(b0, "text", "");
        }
        emit("app/thread", bubbles.size() >= 2 && firstText.contains("第一条问题"),
                bubbles.size() + " 个气泡，首条=" + firstText);

        Map<String, Object> sendParams = new LinkedHashMap<>();
        sendParams.put("sessionId", "session-fake-1");
        sendParams.put("text", "来自 Java 客户端的一句话");
        Map<String, Object> sent = link.call("app/send", sendParams, 30_000);
        emit("app/send", Boolean.TRUE.equals(sent.get("accepted")), "requestId=" + sent.get("requestId"));

        if (subscribe) {
            long fromSeq = Json.num(thread, "cursor", -1);
            link.subscribe("session-fake-1", fromSeq);
            boolean gotAssistant = false;
            boolean gotLive = false;
            long until = System.currentTimeMillis() + 30_000;
            while (System.currentTimeMillis() < until) {
                synchronized (frames) {
                    for (Map<String, Object> frame : frames) {
                        if (!"ev".equals(Json.str(frame, "kind", ""))) continue;
                        for (Object itemObj : Json.arr(frame, "items")) {
                            @SuppressWarnings("unchecked")
                            Map<String, Object> item = (Map<String, Object>) itemObj;
                            String op = Json.str(item, "op", "");
                            if ("add".equals(op) && "assistant".equals(Json.str(item, "role", ""))) gotAssistant = true;
                            if ("live".equals(op)) gotLive = true;
                        }
                    }
                    if (gotAssistant && gotLive) break;
                    frames.wait(300);
                }
            }
            emit("event-stream", gotAssistant && gotLive,
                    "assistant 气泡=" + gotAssistant + " 流式增量=" + gotLive);
        }

        boolean gotAsk = false;
        long askUntil = System.currentTimeMillis() + 15_000;
        while (System.currentTimeMillis() < askUntil && !gotAsk) {
            synchronized (frames) {
                for (Map<String, Object> frame : frames) {
                    if ("ask".equals(Json.str(frame, "kind", ""))) gotAsk = true;
                }
            }
            Thread.sleep(200);
        }
        emit("ask-frame", gotAsk, gotAsk ? "收到审批弹窗帧" : "没收到 ask 帧");

        // ---- 设置页「测试往返」按钮背后的那条路径（SelfTest.run）
        try {
            Map<String, Object> st = SelfTest.run(cfg, message -> logs.add("[self] " + message));
            boolean okAll = Boolean.TRUE.equals(st.get("ok")) && Boolean.TRUE.equals(st.get("deleted"));
            emit("selftest", okAll,
                    "往返 " + st.get("ms") + "ms / 7z 包 " + st.get("bytes") + "B / 删掉=" + st.get("deleted"));
        } catch (Exception e) {
            emit("selftest", false, String.valueOf(e.getMessage()));
        }

        link.stop();
        synchronized (logs) {
            if (!logs.isEmpty()) emit("log-count", true, logs.size() + " 条日志");
        }
        System.exit(0);
    }

    private static void emit(String check, boolean ok, String detail) {
        Map<String, Object> map = new LinkedHashMap<>();
        map.put("check", check);
        map.put("ok", ok);
        map.put("detail", detail);
        System.out.println(Json.stringify(map));
        System.out.flush();
    }

    /** 文件版 Store（手机端是 SharedPreferences）。 */
    static final class FileStore implements Config.Store {
        private final Path path;
        private final Map<String, Object> data = new LinkedHashMap<>();

        FileStore(Path path) {
            this.path = path;
            try {
                if (Files.exists(path)) {
                    data.putAll(Json.parseObject(new String(Files.readAllBytes(path), StandardCharsets.UTF_8)));
                }
            } catch (IOException ignored) {
                // 首次运行 / 文件损坏就当作空
            }
        }

        @Override
        public String get(String key) {
            Object v = data.get(key);
            return v == null ? null : String.valueOf(v);
        }

        @Override
        public void put(String key, String value) {
            data.put(key, value);
            try {
                Files.write(path, Json.stringify(data).getBytes(StandardCharsets.UTF_8));
            } catch (IOException ignored) {
                // 测试环境写不了盘不影响断言
            }
        }
    }
}
