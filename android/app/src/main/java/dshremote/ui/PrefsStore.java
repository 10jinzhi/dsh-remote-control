package dshremote.ui;

import android.content.Context;
import android.content.SharedPreferences;

import dshremote.Config;

/**
 * 手机端的键值存储 —— 用 SharedPreferences 实现核心层的 `Config.Store`。
 *
 * 核心层（`Config` / `RemoteLink` / `Mailbox`）刻意不碰任何 Android API，
 * 就是为了能在开发机上用普通 JVM 跑真实端到端测试；Android 这一侧只需要
 * 提供这一个 20 行的适配器。
 *
 * 同一个 SharedPreferences 里还存着链路的两个游标（`outSeq` / `cursor`），
 * 键名不同，互不干扰。
 */
public final class PrefsStore implements Config.Store {

    private static final String PREFS = "dshremote";

    private final SharedPreferences prefs;

    public PrefsStore(Context context) {
        this.prefs = context.getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    @Override
    public String get(String key) {
        return prefs.getString(key, null);
    }

    @Override
    public void put(String key, String value) {
        // apply() 是异步落盘：链路每轮都会更新游标，用 commit() 会拖慢轮询。
        prefs.edit().putString(key, value).apply();
    }
}
