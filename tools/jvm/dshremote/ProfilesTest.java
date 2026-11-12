package dshremote;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * 多电脑隔离的纯本地断言（不联网、不碰桶）。
 *
 * 为什么单独一个类：这部分逻辑的风险全在「键到底写进了哪个前缀」，跟
 * B2 往返、7z 加解密没有关系。用网络把它包起来测，失败时反而看不清是
 * 隔离错了还是网络抖了。
 *
 *   java -cp <classes> dshremote.ProfilesTest <状态文件路径前缀>
 */
public final class ProfilesTest {

    public static void main(String[] args) throws Exception {
        Path state = Path.of(args.length > 0 ? args[0] : "profiles-test");
        Files.deleteIfExists(state);
        JvmClientTest.FileStore store = new JvmClientTest.FileStore(state);

        // ---- 1) 旧版本把 5 项平铺在根键上：升级后必须被收养成第一条档案
        store.put("appKeyId", "005f-legacy");
        store.put("appKey", "K005legacy");
        store.put("bucket", "bucket-legacy");
        store.put("cloudFile", "desk-win");
        store.put("password", "pw-legacy");

        Profiles profiles = new Profiles(store);
        profiles.adopt();

        String firstId = profiles.activeId();
        Config first = Config.load(profiles.storeFor(firstId));
        String flatLeft = store.get("appKeyId");
        boolean migrated = profiles.list().size() == 1
                && "005f-legacy".equals(first.appKeyId)
                && "bucket-legacy".equals(first.bucket)
                && "pw-legacy".equals(first.password)
                && "desk-win".equals(profiles.nameOf(firstId))
                && (flatLeft == null || flatLeft.isEmpty());
        emit("profiles-migrate", migrated,
                "档案 " + profiles.list().size() + " 条 / 名字「" + profiles.nameOf(firstId) + "」");

        // ---- 2) 新增第二台：两台的 5 项互不可见
        String secondId = profiles.create("书房台式机");
        Config.Store storeA = profiles.storeFor(firstId);
        Config.Store storeB = profiles.storeFor(secondId);

        Config b = Config.load(storeB);
        b.appKeyId = "005f-second";
        b.appKey = "K005second";
        b.bucket = "bucket-second";
        b.cloudFile = "desk-second";
        b.password = "pw-second";
        b.save(storeB);

        Config rereadA = Config.load(storeA);
        Config rereadB = Config.load(storeB);
        boolean configIsolated = "005f-legacy".equals(rereadA.appKeyId)
                && "005f-second".equals(rereadB.appKeyId)
                && !rereadA.appKey.equals(rereadB.appKey)
                && !rereadA.password.equals(rereadB.password);
        emit("profiles-isolate-config", configIsolated,
                "A=" + rereadA.cloudFile + " / B=" + rereadB.cloudFile);

        // ---- 3) 游标必须跟着电脑走（这是最容易漏的一项）
        storeA.put("cursor", "111");
        storeB.put("cursor", "222");
        storeA.put("outSeq", "1111");
        storeB.put("outSeq", "2222");
        boolean cursorIsolated = "111".equals(storeA.get("cursor"))
                && "222".equals(storeB.get("cursor"))
                && "1111".equals(storeA.get("outSeq"))
                && "2222".equals(storeB.get("outSeq"));
        emit("profiles-isolate-cursor", cursorIsolated,
                "A cursor=" + storeA.get("cursor") + " / B cursor=" + storeB.get("cursor"));

        // ---- 4) 云端文件名不同 ⇒ 通道 ID 一定不同（否则两台电脑会抢同一条队列）
        Config.Channel chA = rereadA.channel();
        Config.Channel chB = rereadB.channel();
        boolean distinct = chA != null && chB != null && !chA.channelId.equals(chB.channelId);
        emit("profiles-channel-distinct", distinct,
                (chA == null ? "A=null" : "A=" + chA.channelId) + " / " + (chB == null ? "B=null" : "B=" + chB.channelId));

        // ---- 5) 删光所有电脑：仍留一条空档案，且旧配置不会「复活」
        profiles.remove(firstId);
        profiles.remove(secondId);
        java.util.List<Profiles.Item> left = profiles.list();
        Config survivor = Config.load(profiles.storeFor(profiles.activeId()));
        boolean noGhost = left.size() == 1 && survivor.missing().size() == 5
                && survivor.appKeyId.isEmpty() && survivor.bucket.isEmpty();
        emit("profiles-no-ghost", noGhost,
                "剩 " + left.size() + " 条，缺 " + survivor.missing().size() + " 项");

        Files.deleteIfExists(state);
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
}
