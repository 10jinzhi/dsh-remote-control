package dshremote;

import java.io.UnsupportedEncodingException;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.LinkedHashMap;
import java.util.Map;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

/**
 * 配对配置 —— 与电脑端设置页那 5 个输入框一一对应。
 *
 * <pre>
 *   Application Key ID     appKeyId
 *   Application Key        appKey
 *   Bucket 名称             bucket
 *   云端文件名              cloudFile
 *   加密密码（7z）           password
 * </pre>
 *
 * 两端填同样的五项 ⇒ `channel()` 算出来的通道 ID 相同 ⇒ 同一条通道。
 * 没有配对码、没有二维码、没有第三方服务器。
 *
 * ## 密码为什么不参与通道派生
 *
 * 故意不参与：密码填错时应该得到「7z 解不开」的明确错误，
 * 而不是悄悄换到另一条空通道上、让人以为是网络问题。
 */
public final class Config {

    /** 键值存储的抽象：手机上用 SharedPreferences，开发机测试用文件。 */
    public interface Store {
        String get(String key);

        void put(String key, String value);
    }

    public String appKeyId = "";
    public String appKey = "";
    public String bucket = "";
    public String cloudFile = "";
    public String password = "";

    public static Config load(Store store) {
        Config c = new Config();
        c.appKeyId = safe(store.get("appKeyId"));
        c.appKey = safe(store.get("appKey"));
        c.bucket = safe(store.get("bucket"));
        c.cloudFile = safe(store.get("cloudFile"));
        c.password = safe(store.get("password"));
        return c;
    }

    public void save(Store store) {
        store.put("appKeyId", appKeyId);
        store.put("appKey", appKey);
        store.put("bucket", bucket);
        store.put("cloudFile", cloudFile);
        store.put("password", password);
    }

    /** 还差哪几项（空数组 = 齐全）。 */
    public java.util.List<String> missing() {
        java.util.List<String> out = new java.util.ArrayList<>();
        if (appKeyId.isEmpty()) out.add("Application Key ID");
        if (appKey.isEmpty()) out.add("Application Key");
        if (bucket.isEmpty()) out.add("Bucket 名称");
        if (sanitize(cloudFile).isEmpty()) out.add("云端文件名");
        if (password.isEmpty()) out.add("加密密码");
        return out;
    }

    public boolean complete() {
        return missing().isEmpty();
    }

    /** 通道三元组（与电脑端 `deriveChannel()` 逐字节一致）。 */
    public Channel channel() {
        if (!complete()) return null;
        String cloud = sanitize(cloudFile);
        String salt = "dsh-remote/v1|" + bucket + "|" + cloud;
        String channelId = hmacHex(appKey, "channel-id|" + salt).substring(0, 12);
        String root = "dsh-remote/v1/" + cloud + "/ch/" + channelId;
        String fingerprint = sha256Hex(salt + "|" + channelId).substring(0, 8);
        return new Channel(channelId, root, fingerprint);
    }

    /** B2 对象名不允许随便来：与电脑端同一套清洗规则。 */
    public static String sanitize(String value) {
        if (value == null) return "";
        String raw = value.trim();
        while (raw.startsWith("/")) raw = raw.substring(1);
        while (raw.endsWith("/")) raw = raw.substring(0, raw.length() - 1);
        if (raw.isEmpty()) return "";
        String cleaned = raw.replaceAll("[^\\w.\\-]+", "_");
        return cleaned.length() > 120 ? cleaned.substring(0, 120) : cleaned;
    }

    public Map<String, Object> toMap(boolean maskPassword) {
        Map<String, Object> map = new LinkedHashMap<>();
        map.put("appKeyId", appKeyId);
        map.put("bucket", bucket);
        map.put("cloudFile", cloudFile);
        map.put("hasAppKey", !appKey.isEmpty());
        map.put("hasPassword", !password.isEmpty());
        if (!maskPassword) {
            map.put("appKey", appKey);
            map.put("password", password);
        }
        Channel ch = channel();
        map.put("channel", ch == null ? "" : ch.channelId);
        map.put("fingerprint", ch == null ? "" : ch.fingerprint);
        map.put("missing", missing());
        return map;
    }

    public static final class Channel {
        public final String channelId;
        public final String root;
        public final String fingerprint;

        Channel(String channelId, String root, String fingerprint) {
            this.channelId = channelId;
            this.root = root;
            this.fingerprint = fingerprint;
        }
    }

    // ---------------------------------------------------------------- 摘要

    static String hmacHex(String key, String message) {
        try {
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec(key.getBytes("UTF-8"), "HmacSHA256"));
            return hex(mac.doFinal(message.getBytes("UTF-8")));
        } catch (NoSuchAlgorithmException | java.security.InvalidKeyException | UnsupportedEncodingException e) {
            throw new IllegalStateException("HMAC 不可用：" + e.getMessage(), e);
        }
    }

    static String sha256Hex(String message) {
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            return hex(md.digest(message.getBytes("UTF-8")));
        } catch (NoSuchAlgorithmException | UnsupportedEncodingException e) {
            throw new IllegalStateException("SHA-256 不可用：" + e.getMessage(), e);
        }
    }

    static String hex(byte[] bytes) {
        StringBuilder sb = new StringBuilder(bytes.length * 2);
        for (byte b : bytes) {
            sb.append(Character.forDigit((b >> 4) & 0xF, 16));
            sb.append(Character.forDigit(b & 0xF, 16));
        }
        return sb.toString();
    }

    private static String safe(String v) {
        return v == null ? "" : v.trim();
    }
}
