package dshremote;

import java.io.IOException;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import dshremote.z7.SevenZipReader;
import dshremote.z7.SevenZipWriter;

/**
 * 配对自检 —— 设置页那个「测试往返」按钮背后的全部逻辑。
 *
 * ## 它到底验证了什么
 *
 * 一次完整的「打包 → 上传 → 列举 → 下载 → 解密 → 比对 → 删除」：
 *
 * ```
 *   SevenZipWriter.pack  →  b2_upload_file  →  b2_list_file_names
 *                        →  直连下载        →  SevenZipReader.unpack
 *                        →  校验 nonce      →  b2_delete_file_version
 * ```
 *
 * 这七步正好覆盖配对失败的全部常见原因：密钥不对（授权 401）、桶名写错
 * （找不到 bucket）、密码不一致（解不开 / nonce 对不上）、key 没有写权限
 * （上传 403）、桶是私有的但读不了（下载 401）。
 *
 * ## 为什么不复用 from-phone/ 队列
 *
 * 自检**必须**走独立的 `self/` 前缀。如果拿 `from-phone/` 试，电脑端桥会照常把它
 * 当请求读走并删掉，手机这边就「读不回来」—— 自检会在两端都正常的情况下
 * 报出一个假故障。
 */
public final class SelfTest {

    private SelfTest() {}

    public static Map<String, Object> run(Config cfg, B2Client.Log log) throws IOException {
        Config.Channel channel = cfg.channel();
        if (channel == null) throw new IOException("配置不完整：" + join(cfg.missing()));

        long started = System.currentTimeMillis();
        byte[] nonceBytes = new byte[12];
        new SecureRandom().nextBytes(nonceBytes);
        String nonce = Config.hex(nonceBytes);

        // ① 打包（加密头不加密，与线上帧保持一致）
        Map<String, Object> frame = new LinkedHashMap<>();
        frame.put("kind", "selftest");
        frame.put("at", started);
        frame.put("nonce", nonce);
        List<Object> frames = new ArrayList<>();
        frames.add(frame);
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("v", Mailbox.FRAME_VERSION);
        payload.put("frames", frames);
        byte[] archive = SevenZipWriter.pack(
                Json.stringify(payload).getBytes("UTF-8"), "m.json", cfg.password.toCharArray());

        B2Client client = new B2Client(cfg, log);
        String key = channel.root + "/self/" + started + ".7z";

        // ② 上传
        client.put(key, archive);
        long uploaded = System.currentTimeMillis();

        // ③ 列举（确认 key 真的在桶里，而不是「上传成功但其实没写」）
        String fileId = "";
        for (Map<String, Object> file : client.list(channel.root + "/self/", null, 20)) {
            if (key.equals(Json.str(file, "fileName", ""))) {
                fileId = Json.str(file, "fileId", "");
                break;
            }
        }
        if (fileId.isEmpty()) throw new IOException("上传返回成功，但桶里列举不到这个对象（桶名/权限？）");

        // ④ 下载 + ⑤ 解密 + ⑥ 比对
        byte[] back = client.get(key);
        if (back == null) throw new IOException("对象列举得到但下载不回来（桶是私有的，key 没有读权限？）");
        String text = new String(SevenZipReader.unpack(back, cfg.password.toCharArray()), "UTF-8");
        Map<String, Object> got = Json.parseObject(text);
        String gotNonce = "";
        for (Object item : Json.arr(got, "frames")) {
            @SuppressWarnings("unchecked")
            Map<String, Object> f = (Map<String, Object>) item;
            if ("selftest".equals(Json.str(f, "kind", ""))) gotNonce = Json.str(f, "nonce", "");
        }
        if (!nonce.equals(gotNonce)) {
            // 能解开但内容不对：说明密码是对的、对象是别人的（通道撞了）。
            throw new IOException("解出来的内容不是刚写进去的那份（通道 ID 冲突？）");
        }

        // ⑦ 删除
        boolean deleted = client.deleteVersion(key, fileId);

        Map<String, Object> out = new LinkedHashMap<>();
        out.put("ok", true);
        out.put("ms", System.currentTimeMillis() - started);
        out.put("putMs", uploaded - started);
        out.put("bytes", archive.length);
        out.put("rawBytes", Json.stringify(payload).getBytes("UTF-8").length);
        out.put("key", key);
        out.put("channel", channel.channelId);
        out.put("fingerprint", channel.fingerprint);
        out.put("deleted", deleted);
        return out;
    }

    /** 解绑：把这条通道下所有对象删干净（in/ out/ self/ 全部）。 */
    public static int wipe(Config cfg, B2Client.Log log) throws IOException {
        Config.Channel channel = cfg.channel();
        if (channel == null) throw new IOException("配置不完整：" + join(cfg.missing()));
        B2Client client = new B2Client(cfg, log);
        int deleted = 0;
        for (int round = 0; round < 20; round++) {
            List<Map<String, Object>> files = client.list(channel.root + "/", null, 500);
            if (files.isEmpty()) break;
            for (Map<String, Object> file : files) {
                if (client.deleteVersion(Json.str(file, "fileName", ""), Json.str(file, "fileId", ""))) deleted++;
            }
            if (files.size() < 500) break;
        }
        return deleted;
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
