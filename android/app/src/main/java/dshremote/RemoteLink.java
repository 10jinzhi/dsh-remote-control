package dshremote;

import java.io.IOException;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 连接引擎 —— APK 的全部网络行为都在这里，界面层不做任何 I/O。
 *
 * ## 职责
 *
 *   · 轮询 `out/`：收应答、收渲染好的气泡、收审批弹窗、收心跳；
 *   · 打包 `in/`：发 `app/xxx` 请求、订阅/取消订阅、心跳；
 *   · 维护「电脑是否在线」「当前会话游标」「收发序号」。
 *
 * ## 为什么是一个线程
 *
 * 一条通道只有一个消费者：多线程并发 `take()` 会让同一批对象被处理两次
 * （B2 的列举没有事务语义）。所以用一个循环线程串行处理，请求本身是
 * 「入队 + 等结果」，不会阻塞 UI 线程。
 *
 * ## 自适应节奏
 *
 * 刚有收发 ⇒ 400ms 一轮（体验接近即时）；空闲 ⇒ 1.5s；久无活动 ⇒ 4s。
 * 一次轮询的成本是一次 B2 列举（Class C，$0.000000004/次量级），
 * 慢下来主要是省手机电和流量。
 */
public final class RemoteLink {

    private static final long HB_EVERY_MS = 30_000L;
    private static final long DESK_ALIVE_MS = 90_000L;
    private static final int MAX_PER_TICK = 8;

    public interface Listener {
        /** 收到一条帧：`ev`（渲染好的气泡）、`ask`（审批）、`hb`（电脑心跳）。 */
        void onFrame(Map<String, Object> frame);

        /** 连接状态变化（只在状态真的变了时回调）。 */
        void onState(State state);

        void onLog(String message);
    }

    public static final class State {
        public boolean connected;
        public String message = "未连接";
        public long lastDeskSeenAt;
        public String lastError = "";
        public long lastErrorAt;

        public Map<String, Object> toMap() {
            Map<String, Object> map = new LinkedHashMap<>();
            map.put("connected", connected);
            map.put("message", message);
            map.put("lastDeskSeenAt", lastDeskSeenAt);
            map.put("lastError", lastError);
            return map;
        }
    }

    private final Config.Store store;
    private final Listener listener;

    private Config config;
    private Config.Channel channel;
    private B2Client client;
    private Mailbox box;

    private volatile boolean running;
    private Thread worker;

    private long outSeq;
    private long cursor;
    private long lastDeskSeenAt;
    private long lastActivityAt;
    private long lastHbAt;
    private long lastFlushAt;

    private final List<Map<String, Object>> outbox = new ArrayList<>();
    private final Map<String, Pending> pending = new HashMap<>();
    private final Object lock = new Object();

    private final State state = new State();
    private boolean lastReportedConnected;

    private static final class Pending {
        boolean done;
        boolean ok;
        Object result;
        String error;
    }

    public RemoteLink(Config.Store store, Listener listener) {
        this.store = store;
        this.listener = listener;
        this.outSeq = parseLong(store.get("outSeq"), 0);
        this.cursor = parseLong(store.get("cursor"), 0);
    }

    // ---------------------------------------------------------------- 生命周期

    public synchronized void start() {
        if (running) return;
        config = Config.load(store);
        channel = config.channel();
        if (channel == null) {
            state.connected = false;
            state.message = "配置不完整：" + join(config.missing());
            reportState(true);
            return;
        }
        client = new B2Client(config, this::log);
        box = new Mailbox(client, channel, config.password, this::log);
        if (outSeq <= 0) outSeq = Mailbox.initialSeq();
        running = true;
        worker = new Thread(this::loop, "dshremote-link");
        worker.setDaemon(true);
        worker.start();
        log("已连接通道 " + channel.channelId + "（指纹 " + channel.fingerprint + "）");
    }

    public synchronized void stop() {
        running = false;
        if (worker != null) worker.interrupt();
        worker = null;
        state.connected = false;
        state.message = "已断开";
        reportState(true);
        synchronized (lock) {
            for (Pending p : pending.values()) {
                p.done = true;
                p.ok = false;
                p.error = "已断开";
            }
            pending.clear();
            lock.notifyAll();
        }
    }

    public boolean isRunning() {
        return running;
    }

    public State state() {
        return state;
    }

    public Config config() {
        return config == null ? Config.load(store) : config;
    }

    public Config.Channel channel() {
        return channel;
    }

    // ---------------------------------------------------------------- 对外 API

    /**
     * 发一条 `app/xxx` 请求并等应答。
     *
     * @return 结果对象（已把 `ok/result/error` 展平）
     */
    public Map<String, Object> call(String method, Map<String, Object> params, long timeoutMs) throws IOException {
        if (!running) throw new IOException("尚未连接电脑");
        String id = "m" + System.nanoTime();
        Map<String, Object> frame = new LinkedHashMap<>();
        frame.put("kind", "req");
        frame.put("id", id);
        frame.put("method", method);
        frame.put("params", params == null ? new LinkedHashMap<String, Object>() : params);
        Pending p = new Pending();
        synchronized (lock) {
            pending.put(id, p);
            outbox.add(frame);
            lock.notifyAll();
        }
        long deadline = System.currentTimeMillis() + timeoutMs;
        synchronized (lock) {
            while (!p.done) {
                long wait = deadline - System.currentTimeMillis();
                if (wait <= 0) break;
                try {
                    lock.wait(wait);
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    break;
                }
            }
            pending.remove(id);
        }
        if (!p.done) throw new IOException(method + " 超时（电脑没有回应，检查两端配置是否一致）");
        if (!p.ok) throw new IOException(p.error == null ? "调用失败" : p.error);
        @SuppressWarnings("unchecked")
        Map<String, Object> result = p.result instanceof Map ? (Map<String, Object>) p.result : new LinkedHashMap<>();
        return result;
    }

    /** 订阅某个会话的实时事件。 */
    public void subscribe(String sessionId, long fromSeq) {
        Map<String, Object> frame = new LinkedHashMap<>();
        frame.put("kind", "ctl");
        frame.put("type", "sub");
        frame.put("sessionId", sessionId);
        frame.put("fromSeq", fromSeq);
        enqueue(frame);
    }

    public void unsubscribe(String sessionId) {
        Map<String, Object> frame = new LinkedHashMap<>();
        frame.put("kind", "ctl");
        frame.put("type", "unsub");
        frame.put("sessionId", sessionId);
        enqueue(frame);
    }

    /** 有新东西要发时踢一脚，让循环立刻跑一轮。 */
    public void poke() {
        synchronized (lock) {
            lock.notifyAll();
        }
    }

    private void enqueue(Map<String, Object> frame) {
        synchronized (lock) {
            outbox.add(frame);
            lock.notifyAll();
        }
    }

    // ---------------------------------------------------------------- 循环

    private void loop() {
        while (running) {
            boolean didWork = false;
            try {
                didWork = tick();
                state.lastError = "";
            } catch (Exception e) {
                state.lastError = String.valueOf(e.getMessage());
                state.lastErrorAt = System.currentTimeMillis();
                state.connected = false;
                state.message = "连接异常：" + state.lastError;
                reportState(false);
                log("轮询出错：" + e.getMessage());
                sleep(2000);
                continue;
            }
            long wait = didWork ? 400 : idleDelay();
            synchronized (lock) {
                if (outbox.isEmpty() && running) {
                    try {
                        lock.wait(wait);
                    } catch (InterruptedException e) {
                        Thread.currentThread().interrupt();
                        return;
                    }
                }
            }
        }
    }

    private long idleDelay() {
        long idle = System.currentTimeMillis() - Math.max(lastActivityAt, lastDeskSeenAt);
        if (idle < 60_000) return 400;
        if (idle < 10 * 60_000) return 1500;
        return 4000;
    }

    /** 一轮收发。返回「这一轮有没有干活」。 */
    private boolean tick() throws IOException {
        boolean didWork = false;
        long now = System.currentTimeMillis();

        // ① 发：攒下的帧合并成一个 7z 对象
        List<Map<String, Object>> batch = null;
        synchronized (lock) {
            if (!outbox.isEmpty()) {
                batch = new ArrayList<>(outbox);
                outbox.clear();
            }
        }
        if (batch != null && !batch.isEmpty()) {
            outSeq += 1;
            box.putFrames("phone", outSeq, batch);
            store.put("outSeq", Long.toString(outSeq));
            didWork = true;
        }

        // ② 收
        Mailbox.Batch taken = box.take("desktop", cursor, MAX_PER_TICK);
        if (taken.cursor != cursor) {
            cursor = taken.cursor;
            store.put("cursor", Long.toString(cursor));
            didWork = true;
        }
        if (taken.failed > 0) log(taken.failed + " 个对象解不开（密码不一致？），已跳过但未删除");
        for (Map<String, Object> frame : taken.frames) {
            dispatch(frame);
            didWork = true;
        }

        // ③ 心跳：30 秒一次，让电脑端能显示「手机在线」。
        //    只有 1 个对象/30s 的成本，比按需判断更省心。
        if (now - lastHbAt >= HB_EVERY_MS) {
            lastHbAt = now;
            Map<String, Object> hb = new LinkedHashMap<>();
            hb.put("kind", "hb");
            hb.put("role", "app");
            hb.put("at", now);
            enqueue(hb);
        }

        // ④ 在线状态
        boolean alive = now - lastDeskSeenAt < DESK_ALIVE_MS;
        if (alive != state.connected || lastReportedConnected != alive) {
            state.connected = alive;
            state.message = alive ? "已连接" : "等待电脑响应…";
            reportState(false);
        }
        return didWork;
    }

    private void dispatch(Map<String, Object> frame) {
        String kind = Json.str(frame, "kind", "");
        lastActivityAt = System.currentTimeMillis();
        if ("res".equals(kind)) {
            String id = Json.str(frame, "id", "");
            Pending p;
            synchronized (lock) {
                p = pending.get(id);
                if (p == null) return;
                p.done = true;
                p.ok = Boolean.TRUE.equals(frame.get("ok"));
                p.result = frame.get("result");
                Object err = frame.get("error");
                p.error = err == null ? "" : String.valueOf(err);
                lock.notifyAll();
            }
            return;
        }
        if ("hb".equals(kind)) {
            lastDeskSeenAt = System.currentTimeMillis();
            lastActivityAt = lastDeskSeenAt;
            state.lastDeskSeenAt = lastDeskSeenAt;
            listener.onFrame(frame);
            return;
        }
        if ("ev".equals(kind)) {
            lastDeskSeenAt = System.currentTimeMillis();
            listener.onFrame(frame);
            return;
        }
        if ("ask".equals(kind)) {
            lastDeskSeenAt = System.currentTimeMillis();
            listener.onFrame(frame);
        }
    }

    private void reportState(boolean force) {
        if (!force && lastReportedConnected == state.connected) return;
        lastReportedConnected = state.connected;
        listener.onState(state);
    }

    private void log(String message) {
        listener.onLog(message);
    }

    private void sleep(long ms) {
        try {
            Thread.sleep(ms);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }

    private static long parseLong(String v, long fallback) {
        try {
            return v == null || v.isEmpty() ? fallback : Long.parseLong(v);
        } catch (NumberFormatException e) {
            return fallback;
        }
    }

    private static String join(List<String> list) {
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < list.size(); i++) {
            if (i > 0) sb.append(" / ");
            sb.append(list.get(i));
        }
        return sb.toString();
    }
}
