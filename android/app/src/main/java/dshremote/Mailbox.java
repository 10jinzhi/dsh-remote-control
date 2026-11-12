package dshremote;

import java.io.IOException;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import dshremote.z7.SevenZipReader;
import dshremote.z7.SevenZipWriter;

/**
 * 邮箱协议（手机侧）—— 与电脑端 `lib/mail7z/mailbox.js` 对应。
 *
 * <pre>
 *   手机                                电脑
 *   put  in/&lt;seq&gt;.7z   ─────────►      pull in/
 *   pull out/&lt;seq&gt;.7z  ◄─────────      put  out/
 * </pre>
 *
 * 每条队列只有一个生产者，序号单调递增，消费者按名字升序拉取 ——
 * 于是不需要分布式锁，也不需要处理「版本冲突」。一条对象里可以装多帧
 * （打包 7z 有固定开销，逐帧打包不划算）。
 */
public final class Mailbox {

    public static final int FRAME_VERSION = 1;
    private static final int SEQ_WIDTH = 13;

    private final B2Client client;
    private final Config.Channel channel;
    private final String password;
    private final B2Client.Log log;

    public Mailbox(B2Client client, Config.Channel channel, String password, B2Client.Log log) {
        this.client = client;
        this.channel = channel;
        this.password = password;
        this.log = log;
    }

    public String inPrefix() {
        return channel.root + "/in/";
    }

    public String outPrefix() {
        return channel.root + "/out/";
    }

    public String inKey(long seq) {
        return inPrefix() + pad(seq);
    }

    public String outKey(long seq) {
        return outPrefix() + pad(seq);
    }

    private static String pad(long seq) {
        String s = Long.toString(seq);
        StringBuilder sb = new StringBuilder();
        for (int i = s.length(); i < SEQ_WIDTH; i++) sb.append('0');
        return sb.append(s).append(".7z").toString();
    }

    /**
     * 首次运行的序号起点。
     *
     * 用当前毫秒时间戳：即使应用数据被清空、序号"从头开始"，也依然大于上一轮
     * 的最大值，消费方的游标不会因为序号变小而永久卡住。
     */
    public static long initialSeq() {
        return System.currentTimeMillis();
    }

    /** 打包 + 上传一批帧。 */
    public void putFrames(String queue, long seq, List<Map<String, Object>> frames) throws IOException {
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("v", FRAME_VERSION);
        payload.put("frames", frames);
        byte[] archive = SevenZipWriter.pack(
                Json.stringify(payload).getBytes("UTF-8"), "m.json", password.toCharArray());
        client.put("in".equals(queue) ? inKey(seq) : outKey(seq), archive);
    }

    /** 一帧的解包结果。 */
    public static final class Batch {
        public List<Map<String, Object>> frames = new ArrayList<>();
        public long cursor;
        public int failed;
    }

    /**
     * 取游标之后的帧（含删除）。
     *
     * 解不开的对象**不删除**（密码填错、对象损坏时那是唯一线索），
     * 但游标照样前移，免得一条坏帧把整条队列堵死。
     */
    public Batch take(String queue, long cursor, int max) throws IOException {
        boolean in = "in".equals(queue);
        String prefix = in ? inPrefix() : outPrefix();
        String start = cursor > 0 ? prefix + pad(cursor + 1) : prefix;
        List<Map<String, Object>> files = client.list(prefix, start, max);
        Batch batch = new Batch();
        batch.cursor = cursor;
        for (Map<String, Object> file : files) {
            String fileName = Json.str(file, "fileName", "");
            String fileId = Json.str(file, "fileId", "");
            long seq = parseSeq(prefix, fileName);
            if (seq < 0) {
                client.deleteVersion(fileName, fileId);
                continue;
            }
            if (seq <= cursor) continue;
            try {
                byte[] archive = client.get(fileName);
                if (archive == null) {
                    batch.cursor = Math.max(batch.cursor, seq);
                    continue;
                }
                Map<String, Object> payload = Json.parseObject(
                        new String(SevenZipReader.unpack(archive, password.toCharArray()), "UTF-8"));
                if (Json.num(payload, "v", -1) != FRAME_VERSION) {
                    throw new IOException("帧格式版本不符");
                }
                for (Object item : Json.arr(payload, "frames")) {
                    @SuppressWarnings("unchecked")
                    Map<String, Object> frame = (Map<String, Object>) item;
                    batch.frames.add(frame);
                }
            } catch (Exception e) {
                batch.failed++;
                log.log("跳过坏帧 " + fileName + "：" + e.getMessage());
                batch.cursor = Math.max(batch.cursor, seq);
                continue;
            }
            client.deleteVersion(fileName, fileId);
            batch.cursor = Math.max(batch.cursor, seq);
        }
        return batch;
    }

    private static long parseSeq(String prefix, String fileName) {
        if (!fileName.startsWith(prefix)) return -1;
        String rest = fileName.substring(prefix.length());
        if (!rest.endsWith(".7z")) return -1;
        try {
            return Long.parseLong(rest.substring(0, rest.length() - 3));
        } catch (NumberFormatException e) {
            return -1;
        }
    }
}
