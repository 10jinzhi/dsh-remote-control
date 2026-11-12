package dshremote.ui;

import android.Manifest;
import android.app.Activity;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.ServiceConnection;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.os.Build;
import android.os.Bundle;
import android.os.IBinder;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.WebSettings;
import android.webkit.WebView;

/**
 * 唯一的界面 —— 一个全屏 WebView 装一份本地 HTML。
 *
 * ## 为什么用 WebView 而不是原生控件
 *
 * 这个 APK 的定位是「只负责连接电脑」的瘦客户端：它没有 DSH 知识、不做渲染、
 * 不存历史。界面要的东西很少（表单 + 列表 + 气泡 + 一个输入框），用 HTML 写
 * 一遍比用 RecyclerView + 十几个布局文件更短、更好改，也不用引 AppCompat
 * 那一整条依赖链（本工程是手工 aapt2/d8 构建，没有 Gradle）。
 *
 * ## 安全边界
 *
 * 页面来自 `android_asset`（打包进 APK，只读），JS 只能通过 `window.Android`
 * 这一个注解接口回到原生；不开放 file 访问、不开放跨域请求 —— 所有网络 I/O
 * 都在 Java 侧（`dshremote.B2Client`）。
 */
public final class MainActivity extends Activity {

    private static final int REQ_NOTIFICATION = 0x7a10;

    private WebView webView;
    private UiBridge bridge;
    private LinkService service;

    private final ServiceConnection connection = new ServiceConnection() {
        @Override
        public void onServiceConnected(ComponentName name, IBinder binder) {
            service = ((LinkService.LocalBinder) binder).service();
            service.addListener(bridge);
            // 服务刚起来时界面可能已经画完了，补一条「状态」让状态灯立刻正确
            bridge.ready();
        }

        @Override
        public void onServiceDisconnected(ComponentName name) {
            service = null;
        }
    };

    LinkService service() {
        return service;
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        webView = new WebView(this);
        webView.setLayoutParams(new ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        webView.setBackgroundColor(Color.parseColor("#0F1115"));
        webView.setFitsSystemWindows(true);

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setSupportZoom(false);
        settings.setBuiltInZoomControls(false);
        settings.setTextZoom(100);
        // 页面自己就是全部资源（内联 CSS/JS），不需要开放 file:// 读取权限
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setAllowFileAccessFromFileURLs(false);
        settings.setAllowUniversalAccessFromFileURLs(false);
        settings.setMediaPlaybackRequiresUserGesture(true);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        }

        bridge = new UiBridge(this, webView);
        webView.addJavascriptInterface(bridge, "Android");
        webView.setOverScrollMode(View.OVER_SCROLL_NEVER);
        webView.loadUrl("file:///android_asset/index.html");

        setContentView(webView);

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
                && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            // 通知只是「正在连接」的常驻提示，被拒也不影响链路，所以不解释、不纠缠
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, REQ_NOTIFICATION);
        }
    }

    @Override
    protected void onStart() {
        super.onStart();
        Intent intent = new Intent(this, LinkService.class);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            startForegroundService(intent);
        } else {
            startService(intent);
        }
        bindService(intent, connection, Context.BIND_AUTO_CREATE);
    }

    @Override
    protected void onStop() {
        if (service != null) service.removeListener(bridge);
        try {
            unbindService(connection);
        } catch (IllegalArgumentException ignored) {
            // 没绑上（service 没起来）：无所谓
        }
        service = null;
        super.onStop();
    }

    @Override
    protected void onDestroy() {
        if (webView != null) {
            webView.removeJavascriptInterface("Android");
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }

    /**
     * 返回键先交给页面：页面在自己的「设置 / 聊天」层级里退回上一屏。
     *
     * `evaluateJavascript` 是异步的，不能直接 return；这里用回调里的
     * `"true"` / `"false"` 决定要不要把自己也 finish 掉。
     */
    @Override
    public void onBackPressed() {
        if (webView == null) {
            super.onBackPressed();
            return;
        }
        webView.evaluateJavascript("(window.__onBack && window.__onBack()) ? '1' : '0'", value -> {
            if (!"\"1\"".equals(value)) finish();
        });
    }
}
