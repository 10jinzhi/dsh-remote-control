package dshremote;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 手机端的「电脑列表」—— 一台手机连多台电脑时，每台各自一组 5 项。
 *
 * ## 存法
 *
 * ```
 *   profiles.v1        [{"id":"p1794483231981","name":"书房台式机"}]
 *   profiles.active    p1794483231981
 *   p.<id>.appKeyId    ← 以下都在各自前缀下，含 cursor / outSeq
 *   p.<id>.appKey
 *   p.<id>.bucket
 *   p.<id>.cloudFile
 *   p.<id>.password
 * ```
 *
 * 名字放索引里（改名只写一处），其余全部落在 `ScopedStore` 的前缀下。
 *
 * ## 为什么要迁移旧数据
 *
 * 上一版只有一台电脑，5 项平铺在根键上。升级后如果不收养，用户会看到
 * 「配置没了」——其实数据还在，只是没人去读。所以 {@link #adopt()} 在首次
 * 启动时把它们搬进第一条档案，并把根键清空（不清空的话，删掉所有电脑后
 * 又会被「收养」逻辑复活，出现幽灵配置）。
 *
 * ## 为什么永远至少留一条
 *
 * 界面上的「电脑」是单选，空列表会让整个连接页没有落点。所以删到最后一台时，
 * 直接补一条空的默认档案。
 */
public final class Profiles {

    public static final String KEY_INDEX = "profiles.v1";
    public static final String KEY_ACTIVE = "profiles.active";

    /** 每台电脑在 store 里占的键（删档案时要逐个清空，含游标）。 */
    private static final String[] FIELDS = {
            "appKeyId", "appKey", "bucket", "cloudFile", "password", "cursor", "outSeq",
    };

    private static final String SCOPE = "p.";
    static final String DEFAULT_NAME = "我的电脑";
    private static final int NAME_LIMIT = 24;

    /** 一条档案：只有 id 与显示名；5 项配置在它自己的前缀下。 */
    public static final class Item {
        public final String id;
        public String name;

        public Item(String id, String name) {
            this.id = id == null ? "" : id;
            this.name = name == null ? "" : name;
        }
    }

    private final Config.Store base;

    public Profiles(Config.Store base) {
        this.base = base;
    }

    // ---------------------------------------------------------------- 读写档案

    /** 首次运行（或从旧版本升级）：把平铺配置收养成第一条档案。幂等。 */
    public synchronized void adopt() {
        List<Item> all = read();
        if (!all.isEmpty()) {
            ensureActive(all);
            return;
        }
        Config flat = Config.load(base);
        boolean hasFlat = !flat.appKeyId.isEmpty() || !flat.appKey.isEmpty()
                || !flat.bucket.isEmpty() || !flat.cloudFile.isEmpty() || !flat.password.isEmpty();

        String id = newId();
        Item item = new Item(id, DEFAULT_NAME);
        if (hasFlat) {
            flat.save(storeFor(id));
            // 用云端文件名当默认档案名：用户看到「dsh-remote」比看到「我的电脑」
            // 更容易对上自己那台机器。留空时才退回通用名。
            if (!flat.cloudFile.isEmpty()) item.name = cleanName(flat.cloudFile);
            clearFlat();
        }
        all.add(item);
        write(all);
        base.put(KEY_ACTIVE, id);
    }

    /** 全部档案（至少一条）。 */
    public synchronized List<Item> list() {
        List<Item> all = read();
        if (all.isEmpty()) {
            adopt();
            all = read();
        }
        return all;
    }

    public String activeId() {
        List<Item> all = list();
        String id = base.get(KEY_ACTIVE);
        if (id != null && find(all, id) != null) return id;
        String first = all.isEmpty() ? "" : all.get(0).id;
        if (!first.isEmpty()) base.put(KEY_ACTIVE, first);
        return first;
    }

    /** 切到某台电脑。游标不需要搬 —— 它一直在自己的前缀下。 */
    public synchronized void setActive(String id) {
        if (find(read(), id) == null) throw new IllegalArgumentException("没有这台电脑：" + id);
        base.put(KEY_ACTIVE, id);
    }

    public Config.Store storeFor(String id) {
        return new ScopedStore(base, SCOPE + id + ".");
    }

    public Config.Store activeStore() {
        return storeFor(activeId());
    }

    public boolean has(String id) {
        return find(read(), id) != null;
    }

    public String nameOf(String id) {
        Item item = find(read(), id);
        return item == null ? "" : item.name;
    }

    /**
     * 新增一台电脑。
     *
     * 「云端文件名」默认就用机器名派生（{@link Config#defaultCloudFile}）—— 它决定通道，
     * 所以这一项不同就是另一台机器。预填只是个起点：用户想改成 `desk-win` 之类
     * 更短的短名随时可以，改完再照抄到电脑端即可。
     *
     * 重名要躲开：连着点两次「新增」都用默认名时，两条档案会算出**同一个**通道，
     * 各自维护自己的游标 —— 切过去就会看到「消息凭空少了一半」这种最难查的现象。
     */
    public synchronized String create(String name) {
        List<Item> all = read();
        String id = newId();
        while (find(all, id) != null) id = newId();
        Item item = new Item(id, cleanName(name));
        all.add(item);
        write(all);
        base.put(KEY_ACTIVE, id);
        storeFor(id).put("cloudFile", unusedCloudFile(Config.defaultCloudFile(item.name), id));
        return id;
    }

    /** 占位档案（删光所有电脑后补的那条）：不预填云端文件名，它只是给界面一个落点。 */
    private synchronized String createPlaceholder(String name) {
        List<Item> all = read();
        String id = newId();
        while (find(all, id) != null) id = newId();
        all.add(new Item(id, cleanName(name)));
        write(all);
        base.put(KEY_ACTIVE, id);
        return id;
    }

    /**
     * 挑一个还没有被任何档案占用的云端文件名。
     *
     * 撞了就追加 `-2`、`-3`…，实在不行用 id 尾巴兜底 —— 宁可生成一个丑名字，
     * 也不能让两条档案指向同一条队列。
     */
    private String unusedCloudFile(String base, String selfId) {
        List<Item> all = read();
        java.util.Set<String> taken = new java.util.HashSet<>();
        for (Item item : all) {
            if (item.id.equals(selfId)) continue;
            taken.add(Config.load(storeFor(item.id)).cloudFile);
        }
        if (!taken.contains(base)) return base;
        for (int i = 2; i <= 9; i++) {
            String candidate = base + "-" + i;
            if (!taken.contains(candidate)) return candidate;
        }
        return base + "-" + selfId.substring(Math.max(0, selfId.length() - 4));
    }

    public synchronized void rename(String id, String name) {
        List<Item> all = read();
        Item item = find(all, id);
        if (item == null) throw new IllegalArgumentException("没有这台电脑：" + id);
        item.name = cleanName(name);
        write(all);
    }

    /** 删一台，并清掉它前缀下的全部键（密码不该留在存储里）。 */
    public synchronized void remove(String id) {
        List<Item> all = read();
        Item item = find(all, id);
        if (item == null) return;

        Config.Store scoped = storeFor(id);
        for (String field : FIELDS) scoped.put(field, "");

        all.remove(item);
        write(all);
        if (all.isEmpty()) {
            createPlaceholder(DEFAULT_NAME);
            return;
        }
        if (id.equals(base.get(KEY_ACTIVE))) base.put(KEY_ACTIVE, all.get(0).id);
    }

    // ---------------------------------------------------------------- 内部

    private List<Item> read() {
        List<Item> out = new ArrayList<>();
        String json = base.get(KEY_INDEX);
        if (json == null || json.trim().isEmpty()) return out;
        try {
            Object parsed = Json.parse(json);
            if (!(parsed instanceof List)) return out;
            for (Object raw : (List<?>) parsed) {
                if (!(raw instanceof Map)) continue;
                Map<?, ?> map = (Map<?, ?>) raw;
                Object id = map.get("id");
                if (!(id instanceof String) || ((String) id).isEmpty()) continue;
                Object name = map.get("name");
                out.add(new Item((String) id, name instanceof String ? (String) name : ""));
            }
        } catch (RuntimeException ignored) {
            // 索引坏了就当空：下面会重建一条空档案。让 App 打不开是最差的结果。
        }
        return out;
    }

    private void write(List<Item> all) {
        List<Object> arr = new ArrayList<>();
        for (Item item : all) {
            Map<String, Object> map = new LinkedHashMap<>();
            map.put("id", item.id);
            map.put("name", item.name);
            arr.add(map);
        }
        base.put(KEY_INDEX, Json.stringify(arr));
    }

    private void ensureActive(List<Item> all) {
        String id = base.get(KEY_ACTIVE);
        if (id != null && find(all, id) != null) return;
        if (!all.isEmpty()) base.put(KEY_ACTIVE, all.get(0).id);
    }

    private void clearFlat() {
        Config.Store flat = base;
        for (String field : FIELDS) flat.put(field, "");
    }

    private static Item find(List<Item> all, String id) {
        if (id == null || id.isEmpty()) return null;
        for (Item item : all) if (id.equals(item.id)) return item;
        return null;
    }

    /**
     * 生成一个必然增长的 id。
     *
     * 原先是裸的 `System.currentTimeMillis()`：连点两次「新增」会拿到同一个
     * 毫秒，`while (find(all, id) != null) id = newId()` 就变成死循环 ——
     * 在 UI 线程上就是一次 ANR。这里强制单调递增，撞车只会发生在跨进程，
     * 而手机上只有一个进程。
     */
    private static long lastIdMs = 0;

    private static synchronized String newId() {
        long now = System.currentTimeMillis();
        if (now <= lastIdMs) now = lastIdMs + 1;
        lastIdMs = now;
        return "p" + now;
    }

    private static String cleanName(String name) {
        String value = name == null ? "" : name.trim();
        if (value.isEmpty()) return DEFAULT_NAME;
        return value.length() > NAME_LIMIT ? value.substring(0, NAME_LIMIT) : value;
    }
}
