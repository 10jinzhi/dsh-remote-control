package dshremote;

/**
 * 给所有键加前缀的 `Config.Store`。
 *
 * ## 为什么多电脑靠它实现
 *
 * 手机端全部状态都走 `Config.Store` 这一个口子：5 项配置、收帧游标 `cursor`、
 * 发帧序号 `outSeq`。所以「一会儿连台式机、一会儿连笔记本，两边的游标不能串」
 * 这件事，只要给键加一层前缀就够了 —— `Config` 与 `RemoteLink` 完全不知道自己
 * 被装进了某个档案里。
 *
 * 反过来说，如果改成「配置存一份、游标存一份」，就一定会出现某天新增的状态键
 * 忘了隔离、两台电脑互相吞消息的问题。前缀是唯一不会漏的做法。
 */
public final class ScopedStore implements Config.Store {

    private final Config.Store base;
    private final String prefix;

    public ScopedStore(Config.Store base, String prefix) {
        this.base = base;
        this.prefix = prefix == null ? "" : prefix;
    }

    @Override
    public String get(String key) {
        return base.get(prefix + key);
    }

    @Override
    public void put(String key, String value) {
        base.put(prefix + key, value);
    }

    public String prefix() {
        return prefix;
    }
}
