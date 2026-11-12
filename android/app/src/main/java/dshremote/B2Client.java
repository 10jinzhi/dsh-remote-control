package dshremote;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Backblaze B2 Native API 的手机端封装（零第三方依赖，只用 JDK/android 自带类）。
 *
 * 与电脑端 `lib/mail7z/b2.js` 行为等价：授权 → 复用上传 URL → 直连下载，
 * 不支持时回退 `b2_download_file_by_id`。两端只共用 B2 的公开 HTTP API，
 * 不共用代码，所以任何一边升级 B2 逻辑都不会影响另一边。
 */
public final class B2Client {

    private static final String API = "/b2api/v3/";
    private static final int TIMEOUT_MS = 20_000;

    /**
     * 授权地址。生产环境永远是官方域名。
     *
     * `setAuthorizeUrl` 只给开发机上的端到端测试用（指向 `tools/local-b2.mjs`
     * 这个本地桩，避免消耗真桶的 transaction 配额）。APK 里没有任何代码会调它。
     */
    private static String authorizeUrl = "https://api.backblazeb2.com/b2api/v3/b2_authorize_account";

    public static void setAuthorizeUrl(String url) {
        if (url != null && !url.isEmpty()) authorizeUrl = url;
    }

    private final String appKeyId;
    private final String appKey;
    private final String bucket;

    private String token;
    private String apiUrl;
    private String downloadUrl;
    private String bucketId;
    private long authExpiresAt;

    private String uploadUrl;
    private String uploadToken;
    private long uploadExpiresAt;

    private boolean directBroken;

    public interface Log {
        void log(String message);
    }

    private final Log log;

    public B2Client(Config cfg, Log log) {
        this.appKeyId = cfg.appKeyId;
        this.appKey = cfg.appKey;
        this.bucket = cfg.bucket;
        this.log = log;
    }

    public void authorize(boolean force) throws IOException {
        if (!force && token != null && System.currentTimeMillis() < authExpiresAt) return;
        String basic = Base64.encode((appKeyId + ":" + appKey).getBytes("UTF-8"));
        Map<String, String> headers = new LinkedHashMap<>();
        headers.put("Authorization", "Basic " + basic);
        Response res = request(authorizeUrl, "GET", headers, null);
        if (res.status != 200) {
            throw new IOException("B2 授权失败 HTTP " + res.status + "：" + snippet(res.body));
        }
        Map<String, Object> d = Json.parseObject(res.text());
        Map<String, Object> storage = Json.obj(Json.obj(d, "apiInfo"), "storageApi");
        apiUrl = trimSlash(Json.str(d, "apiUrl", storage == null ? "" : Json.str(storage, "apiUrl", "")));
        downloadUrl = trimSlash(Json.str(d, "downloadUrl", storage == null ? "" : Json.str(storage, "downloadUrl", "")));
        token = Json.str(d, "authorizationToken", "");
        bucketId = storage == null ? null : Json.str(storage, "bucketId", null);
        authExpiresAt = System.currentTimeMillis() + 23L * 3600 * 1000;
        if (bucketId == null || bucketId.isEmpty()) {
            Map<String, Object> payload = new LinkedHashMap<>();
            payload.put("accountId", Json.str(d, "accountId", ""));
            Map<String, Object> listed = api("b2_list_buckets", payload, true);
            List<Object> buckets = Json.arr(listed, "buckets");
            for (Object item : buckets) {
                @SuppressWarnings("unchecked")
                Map<String, Object> b = (Map<String, Object>) item;
                if (bucket.equals(Json.str(b, "bucketName", ""))) {
                    bucketId = Json.str(b, "bucketId", "");
                    break;
                }
            }
            if (bucketId == null || bucketId.isEmpty()) throw new IOException("账号下找不到 bucket「" + bucket + "」");
        }
        log.log("B2 授权成功，bucket=" + bucket);
    }

    public Map<String, Object> api(String action, Map<String, Object> payload, boolean skipRetry)
            throws IOException {
        authorize(false);
        Map<String, String> headers = new LinkedHashMap<>();
        headers.put("Authorization", token);
        headers.put("content-type", "application/json");
        byte[] body = Json.stringify(payload).getBytes("UTF-8");
        Response res = request(apiUrl + API + action, "POST", headers, body);
        if (res.status == 401 && !skipRetry) {
            authorize(true);
            headers.put("Authorization", token);
            res = request(apiUrl + API + action, "POST", headers, body);
        }
        if (res.status != 200) {
            throw new IOException(action + " 失败 HTTP " + res.status + "：" + snippet(res.body));
        }
        return Json.parseObject(res.text());
    }

    private void ensureUploadUrl(boolean force) throws IOException {
        if (!force && uploadUrl != null && System.currentTimeMillis() < uploadExpiresAt) return;
        Map<String, Object> payload = new LinkedHashMap<>();
        authorize(false);
        payload.put("bucketId", bucketId);
        Map<String, Object> d = api("b2_get_upload_url", payload, false);
        uploadUrl = Json.str(d, "uploadUrl", "");
        uploadToken = Json.str(d, "authorizationToken", "");
        uploadExpiresAt = System.currentTimeMillis() + 12L * 3600 * 1000;
    }

    /** 上传一个对象。key 整体 URL 编码（与官方示例一致，`/` 变 `%2F`）。 */
    public void put(String key, byte[] payload) throws IOException {
        String sha1 = sha1Hex(payload);
        IOException last = null;
        for (int attempt = 0; attempt < 3; attempt++) {
            try {
                ensureUploadUrl(attempt > 0);
                Map<String, String> headers = new LinkedHashMap<>();
                headers.put("Authorization", uploadToken);
                headers.put("X-Bz-File-Name", urlEncode(key));
                headers.put("Content-Type", "b2/x-auto");
                headers.put("X-Bz-Content-Sha1", sha1);
                Response res = request(uploadUrl, "POST", headers, payload);
                if (res.status == 200) return;
                last = new IOException("上传失败 HTTP " + res.status + "：" + snippet(res.body));
            } catch (IOException e) {
                last = e;
            }
            uploadUrl = null; // 失败的 uploadUrl 不再复用
            sleepQuiet(250L * (attempt + 1));
        }
        throw last == null ? new IOException("B2 上传失败") : last;
    }

    /** 下载；不存在返回 null。 */
    public byte[] get(String key) throws IOException {
        authorize(false);
        if (!directBroken) {
            String direct = downloadUrl + "/file/" + urlEncode(bucket) + "/" + urlEncode(key);
            Map<String, String> headers = new LinkedHashMap<>();
            headers.put("Authorization", token);
            headers.put("cache-control", "no-cache");
            try {
                Response res = request(direct, "GET", headers, null);
                if (res.status == 200) return res.body;
                if (res.status == 404) return null;
            } catch (IOException e) {
                directBroken = true;
                log.log("B2 下载域不可达（" + e.getMessage() + "），改走 byId 兜底");
            }
        }
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("bucketId", bucketId);
        payload.put("prefix", key);
        payload.put("maxFileCount", 10);
        Map<String, Object> listed = api("b2_list_file_names", payload, false);
        String fileId = null;
        for (Object item : Json.arr(listed, "files")) {
            @SuppressWarnings("unchecked")
            Map<String, Object> f = (Map<String, Object>) item;
            if (key.equals(Json.str(f, "fileName", ""))) {
                fileId = Json.str(f, "fileId", "");
                break;
            }
        }
        if (fileId == null) return null;
        Map<String, String> headers = new LinkedHashMap<>();
        headers.put("Authorization", token);
        Response res = request(apiUrl + API + "b2_download_file_by_id?fileId=" + urlEncode(fileId), "GET", headers, null);
        if (res.status == 200) return res.body;
        if (res.status == 404) return null;
        throw new IOException(key + " 下载失败 HTTP " + res.status);
    }

    /** 列前缀（按名字升序）；`startFileName` 让我们从游标之后开始列。 */
    public List<Map<String, Object>> list(String prefix, String startFileName, int maxFileCount) throws IOException {
        authenticateForList();
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("bucketId", bucketId);
        payload.put("prefix", prefix);
        payload.put("maxFileCount", maxFileCount);
        if (startFileName != null && !startFileName.isEmpty()) payload.put("startFileName", startFileName);
        Map<String, Object> d = api("b2_list_file_names", payload, false);
        List<Map<String, Object>> out = new ArrayList<>();
        for (Object item : Json.arr(d, "files")) {
            @SuppressWarnings("unchecked")
            Map<String, Object> f = (Map<String, Object>) item;
            out.add(f);
        }
        return out;
    }

    private void authenticateForList() throws IOException {
        authorize(false);
    }

    public boolean deleteVersion(String fileName, String fileId) {
        try {
            Map<String, Object> payload = new LinkedHashMap<>();
            payload.put("fileName", fileName);
            payload.put("fileId", fileId);
            api("b2_delete_file_version", payload, false);
            return true;
        } catch (IOException e) {
            log.log("删除对象失败 " + fileName + "：" + e.getMessage());
            return false;
        }
    }

    // ---------------------------------------------------------------- HTTP

    static final class Response {
        int status;
        byte[] body;

        String text() throws IOException {
            return new String(body, "UTF-8");
        }
    }

    private Response request(String url, String method, Map<String, String> headers, byte[] body) throws IOException {
        HttpURLConnection conn = null;
        try {
            conn = (HttpURLConnection) new URL(url).openConnection();
            conn.setRequestMethod(method);
            conn.setConnectTimeout(TIMEOUT_MS);
            conn.setReadTimeout(TIMEOUT_MS);
            conn.setInstanceFollowRedirects(true);
            for (Map.Entry<String, String> e : headers.entrySet()) conn.setRequestProperty(e.getKey(), e.getValue());
            if (body != null) {
                conn.setDoOutput(true);
                conn.setFixedLengthStreamingMode(body.length);
                OutputStream out = conn.getOutputStream();
                out.write(body);
                out.close();
            }
            Response res = new Response();
            res.status = conn.getResponseCode();
            InputStream in = res.status >= 400 ? conn.getErrorStream() : conn.getInputStream();
            res.body = in == null ? new byte[0] : readAll(in);
            return res;
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    private static byte[] readAll(InputStream in) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int n;
        while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
        in.close();
        return out.toByteArray();
    }

    // ---------------------------------------------------------------- 小工具

    private static String trimSlash(String s) {
        String v = s == null ? "" : s;
        while (v.endsWith("/")) v = v.substring(0, v.length() - 1);
        return v;
    }

    private static String urlEncode(String s) {
        try {
            return URLEncoder.encode(s, "UTF-8").replace("+", "%20");
        } catch (java.io.UnsupportedEncodingException e) {
            throw new IllegalStateException(e);
        }
    }

    private static String sha1Hex(byte[] data) throws IOException {
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-1");
            return Config.hex(md.digest(data));
        } catch (java.security.NoSuchAlgorithmException e) {
            throw new IOException("SHA-1 不可用", e);
        }
    }

    private static String snippet(byte[] body) {
        try {
            String s = new String(body, "UTF-8");
            return s.length() > 200 ? s.substring(0, 200) : s;
        } catch (java.io.UnsupportedEncodingException e) {
            return "";
        }
    }

    private static void sleepQuiet(long ms) {
        try {
            Thread.sleep(ms);
        } catch (InterruptedException ignored) {
            Thread.currentThread().interrupt();
        }
    }

    /** 极简 Base64（避免依赖 android.util.Base64，保持核心可在 JVM 上跑）。 */
    static final class Base64 {
        private static final char[] ALPHABET =
                "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/".toCharArray();

        static String encode(byte[] data) {
            StringBuilder sb = new StringBuilder((data.length + 2) / 3 * 4);
            for (int i = 0; i < data.length; i += 3) {
                int b0 = data[i] & 0xFF;
                int b1 = i + 1 < data.length ? data[i + 1] & 0xFF : 0;
                int b2 = i + 2 < data.length ? data[i + 2] & 0xFF : 0;
                sb.append(ALPHABET[b0 >> 2]);
                sb.append(ALPHABET[((b0 & 0x03) << 4) | (b1 >> 4)]);
                sb.append(i + 1 < data.length ? ALPHABET[((b1 & 0x0F) << 2) | (b2 >> 6)] : '=');
                sb.append(i + 2 < data.length ? ALPHABET[b2 & 0x3F] : '=');
            }
            return sb.toString();
        }
    }
}
