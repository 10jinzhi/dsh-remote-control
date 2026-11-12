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

    public synchronized String create(String name) {
        List<Item> all = read();
        String id = newId();
        while (find(all, id) != null) id = newId();
        all.add(new Item(id, cleanName(name)));
        write(all);
        base.put(KEY_ACTIVE, id);
        return id;
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
            create(DEFAULT_NAME);
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

    private static String newId() {
        return "p" + System.currentTimeMillis();
    }

    private static String cleanName(String name) {
        String value = name == null ? "" : name.trim();
        if (value.isEmpty()) return DEFAULT_NAME;
        return value.length() > NAME_LIMIT ? value.substring(0, NAME_LIMIT) : value;
    }
}
