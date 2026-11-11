package com.mineradio.soundfield;

import android.os.Bundle;
import android.webkit.WebSettings;
import android.webkit.WebView;

import com.getcapacitor.BridgeActivity;

/**
 * 应用入口：Capacitor 的 BridgeActivity 已经把 WebView、本地资源服务器（https://localhost）
 * 和插件桥接装好了，这里只做两件事：
 *   1. 注册自定义插件（FoliaBridge 网络代理）；
 *   2. 打开媒体自动播放与混合内容——车机上首歌一进来就该响，不能等用户点一下。
 */
public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // registerPlugin 必须在 super.onCreate 之前，否则 Capacitor 初始化时插件表里还没有它
        registerPlugin(FoliaBridgePlugin.class);
        super.onCreate(savedInstanceState);

        WebView webView = getBridge() == null ? null : getBridge().getWebView();
        if (webView != null) {
            WebSettings settings = webView.getSettings();
            // 音频/视频自动播放：车机场景不应要求先点一下屏幕才有声音
            settings.setMediaPlaybackRequiresUserGesture(false);
            // 酷狗 VIP 部分音频只有 http 地址，页面是 https，需允许混合内容
            settings.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
            // 允许 DOM 存储，扫码登录的 Cookie 才能在 WebView 里落地
            settings.setDomStorageEnabled(true);
            settings.setDatabaseEnabled(true);
        }
    }
}
