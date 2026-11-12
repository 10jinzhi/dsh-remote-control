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

        // ---- 6) 「机器名 → 云端文件名」规则：ASCII 名保留可读，中文名退化成短名
        // 这里的字面量是硬编码的：电脑端 JS 用同一套字面量断言，两端一旦漂移
        // 就会有一边红 —— 漂移的后果是同一台机器算出两条通道，最难查的一类。
        String ascii = Config.defaultCloudFile("DESKTOP-8K3F2L");
        String cjk = Config.defaultCloudFile("书房台式机");
        String spaced = Config.defaultCloudFile("  Mac mini (客厅)  ");
        boolean slugOk = "desktop-8k3f2l".equals(ascii)
                && "desk-ec4d11".equals(cjk)
                && "mac-mini".equals(spaced)
                && "desk-e3b0c4".equals(Config.defaultCloudFile(""));
        emit("cloud-default-slug", slugOk,
                ascii + " / " + cjk + " / " + spaced);

        // ---- 7) 新增电脑时会预填云端文件名（用户不用自己想英文名）
        String c1 = profiles.create("书房台式机");
        String c2 = profiles.create("书房台式机");
        Config one = Config.load(profiles.storeFor(c1));
        Config two = Config.load(profiles.storeFor(c2));
        boolean prefilled = cjk.equals(one.cloudFile)
                && two.cloudFile.startsWith(cjk)
                && !one.cloudFile.equals(two.cloudFile);
        emit("cloud-default-prefill", prefilled,
                "①" + one.cloudFile + " / ②" + two.cloudFile);

        // ---- 8) 四项完全一样、只有云端文件名不同 ⇒ 就是两台机器（通道必须不同）
        for (String id : new String[]{c1, c2}) {
            Config cfg = Config.load(profiles.storeFor(id));
            cfg.appKeyId = "005f-shared";
            cfg.appKey = "K005shared";
            cfg.bucket = "bucket-shared";
            cfg.password = "pw-shared";
            cfg.save(profiles.storeFor(id));
        }
        Config.Channel n1 = Config.load(profiles.storeFor(c1)).channel();
        Config.Channel n2 = Config.load(profiles.storeFor(c2)).channel();
        boolean sameExceptCloud = n1 != null && n2 != null
                && !n1.channelId.equals(n2.channelId)
                && !n1.root.equals(n2.root);
        emit("cloud-only-diff-is-new-machine", sameExceptCloud,
                (n1 == null ? "①=null" : "①" + n1.channelId) + " / " + (n2 == null ? "②=null" : "②" + n2.channelId));

        // ---- 9) 连续新增不能撞 id（以前同毫秒会死循环 = ANR）
        java.util.Set<String> ids = new java.util.HashSet<>();
        for (int i = 0; i < 20; i++) ids.add(profiles.create("批量 " + i));
        emit("cloud-id-monotonic", ids.size() == 20, "20 次新增得到 " + ids.size() + " 个 id");

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
