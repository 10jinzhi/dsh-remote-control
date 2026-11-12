package dshremote.ui;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Binder;
import android.os.Build;
import android.os.IBinder;

import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;

import dshremote.Config;
import dshremote.Profiles;
import dshremote.RemoteLink;

/**
 * 前台服务 —— 链路真正的宿主。
 *
 * ## 为什么必须放服务里
 *
 * 这个 APK 没有本地能力，所有内容都在电脑上；一旦进程被回收，手机上就什么
 * 都看不到了。放在 Activity 里意味着「切到后台就可能断」，用户回来还得重连
 * 一次 —— 那就不像个远程客户端了。前台服务的通知也顺带成了「正在连接」的
 * 常驻提示。
 *
 * ## 为什么不用 AIDL
 *
 * 服务与界面同一个进程，`LocalBinder` 直接拿实例就够了。AIDL 是为跨进程
 * 准备的复杂度，这里一点都用不上。
 *
 * ## 生命周期
 *
 * ```
 *   Activity.onStart   → startForegroundService() + bindService()
 *   Activity.onStop    → unbindService()      （服务继续跑，通知还在）
 *   用户点「断开」       → stopLink()           （链路停，服务仍在，只是不轮询）
 *   系统回收 / 用户清任务 → onDestroy()         （链路停）
 * ```
 */
public final class LinkService extends Service {

    public static final String CHANNEL_ID = "dshremote-link";
    private static final int NOTIFICATION_ID = 0x7a01;

    /** 界面订阅链路事件用。回调都在链路的轮询线程上，界面自己负责切主线程。 */
    public interface Listener {
        void onFrame(Map<String, Object> frame);

        void onState(RemoteLink.State state);

        void onLog(String message);
    }

    private final CopyOnWriteArrayList<Listener> listeners = new CopyOnWriteArrayList<>();
    private final IBinder binder = new LocalBinder();

    private PrefsStore store;
    private Profiles profiles;
    private RemoteLink link;
    private String lastTitle = "";
    private String lastText = "";

    public final class LocalBinder extends Binder {
        public LinkService service() {
            return LinkService.this;
        }
    }

    @Override
    public void onCreate() {
        super.onCreate();
        store = new PrefsStore(this);
        // 先收养旧版平铺配置，再建链路 —— 否则第一次升级会「配置凭空消失」
        profiles = new Profiles(store);
        profiles.adopt();
        ensureChannel();
        // Android 8 起必须先 startForeground，否则 5 秒内会被判 ANR 型崩溃
        startForegroundCompat("未连接", "等待配置");
        ensureLink();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        ensureLink();
        return START_STICKY;
    }

    @Override
    public IBinder onBind(Intent intent) {
        return binder;
    }

    @Override
    public void onDestroy() {
        if (link != null) {
            link.stop();
            link = null;
        }
        super.onDestroy();
    }

    // ---------------------------------------------------------------- 对界面

    public PrefsStore store() {
        return store;
    }

    public RemoteLink link() {
        return link;
    }

    public Profiles profiles() {
        return profiles;
    }

    /** 当前选中那次电脑的配置（每台电脑各自一份）。 */
    public Config config() {
        return Config.load(profiles.activeStore());
    }

    public void addListener(Listener listener) {
        if (listener != null && !listeners.contains(listener)) listeners.add(listener);
    }

    public void removeListener(Listener listener) {
        listeners.remove(listener);
    }

    /** 配置改了（或用户点了重连）：把旧链路丢掉，按新配置重建。 */
    public void restartLink() {
        if (link != null) {
            link.stop();
            link = null;
        }
        ensureLink();
    }

    public void stopLink() {
        if (link != null) {
            link.stop();
            link = null;
        }
        updateNotification("已断开", "点开应用可重新连接");
    }

    /** 没有链路且配置齐全时建一条（幂等）。 */
    public void ensureLink() {
        if (link != null) return;
        Config cfg = Config.load(profiles.activeStore());
        if (!cfg.complete()) {
            updateNotification("未配置", "还差 " + cfg.missing().size() + " 项配对信息");
            return;
        }
        // 链路只拿到「当前这台电脑」的 scoped store：配置与游标都在它自己的前缀下，
        // 切电脑时换的是整个 store，不存在两个实例共用一份游标的可能。
        link = new RemoteLink(profiles.activeStore(), new RemoteLink.Listener() {
            @Override
            public void onFrame(Map<String, Object> frame) {
                for (Listener listener : listeners) listener.onFrame(frame);
            }

            @Override
            public void onState(RemoteLink.State state) {
                updateNotification(
                        state.connected ? "已连接 " + computerName() : "等待电脑响应",
                        state.connected ? "通道 " + channelId() : state.message);
                for (Listener listener : listeners) listener.onState(state);
            }

            @Override
            public void onLog(String message) {
                for (Listener listener : listeners) listener.onLog(message);
            }
        });
        link.start();
    }

    private String computerName() {
        String name = profiles.nameOf(profiles.activeId());
        return name.isEmpty() ? "电脑" : name;
    }

    private String channelId() {
        Config cfg = Config.load(profiles.activeStore());
        Config.Channel ch = cfg.channel();
        return ch == null ? "—" : ch.channelId;
    }

    // ---------------------------------------------------------------- 通知

    private void ensureChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager == null) return;
        if (manager.getNotificationChannel(CHANNEL_ID) != null) return;
        NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID, "远程连接", NotificationManager.IMPORTANCE_LOW);
        channel.setDescription("保持与电脑端的加密邮箱通道");
        channel.setShowBadge(false);
        manager.createNotificationChannel(channel);
    }

    private void startForegroundCompat(String title, String text) {
        Notification notification = build(title, text);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
        } else {
            startForeground(NOTIFICATION_ID, notification);
        }
    }

    private void updateNotification(String title, String text) {
        if (title.equals(lastTitle) && text.equals(lastText)) return;
        lastTitle = title;
        lastText = text;
        NotificationManager manager = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (manager != null) manager.notify(NOTIFICATION_ID, build(title, text));
    }

    private Notification build(String title, String text) {
        Notification.Builder builder;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            builder = new Notification.Builder(this, CHANNEL_ID);
        } else {
            builder = new Notification.Builder(this);
        }
        Intent open = new Intent(this, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        int flags = Build.VERSION.SDK_INT >= Build.VERSION_CODES.M
                ? PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
                : PendingIntent.FLAG_UPDATE_CURRENT;
        PendingIntent content = PendingIntent.getActivity(this, 0, open, flags);
        builder.setContentTitle(title)
                .setContentText(text)
                .setSmallIcon(android.R.drawable.stat_sys_download_done)
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setContentIntent(content);
        return builder.build();
    }
}
