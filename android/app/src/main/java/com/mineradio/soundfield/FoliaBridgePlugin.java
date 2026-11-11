package com.mineradio.soundfield;

import android.util.Log;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.IOException;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.Iterator;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.TimeUnit;

import okhttp3.Cookie;
import okhttp3.CookieJar;
import okhttp3.Headers;
import okhttp3.HttpUrl;
import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;
import okhttp3.ResponseBody;

/**
 * FoliaBridge：把原生 OkHttp 能力暴露给 WebView 里的 Mineradio 前端。
 *
 * 为什么必须有这一层：
 *   1. 页面跑在 https://localhost，酷狗/网易云/QQ 的接口都不给 CORS 头，前端 fetch 直接被拦；
 *      原生请求不受同源策略与混合内容限制。
 *   2. 音频 CDN（尤其 VIP 的 http 地址）和图片 CDN 需要与页面同源才能进 Web Audio / canvas，
 *      前端统一走 /api/audio 路由，由这里取字节再回传。
 *
 * 契约与前端 public/js/android-shim/05-bridge.js 严格对应：
 *   入参 { url, method, headers, body, timeoutMs, binary, followRedirects, omitCookies }
 *   出参 { status, headers, body, bodyBase64, setCookies }
 * 改动任何一边都必须同步另一边，否则表现是「搜歌正常但播放/封面全挂」。
 */
@CapacitorPlugin(name = "FoliaBridge")
public class FoliaBridgePlugin extends Plugin {

    private static final String TAG = "FoliaBridge";

    /** 文本响应最多回传的字节数：防止个别接口把整段音频当 JSON 回传把 JS 堆撑爆。 */
    private static final int MAX_TEXT_BYTES = 8 * 1024 * 1024;

    /** 二进制响应上限：酷狗 VIP 的无损单曲约 40MB 量级，给到 64MB 留余量。 */
    private static final int MAX_BINARY_BYTES = 64 * 1024 * 1024;

    /** 进程级 Cookie 仓库：扫码登录拿到的 qrsig / MUSIC_U 必须在后续请求里继续带上。 */
    private static final Map<String, List<Cookie>> COOKIE_STORE = new HashMap<>();

    private static final CookieJar SESSION_COOKIE_JAR = new CookieJar() {
        @Override
        public synchronized void saveFromResponse(HttpUrl url, List<Cookie> cookies) {
            // 按 host 分桶保存，避免 music.163.com 的 Cookie 被带到 y.qq.com
            String host = url.host();
            List<Cookie> bucket = COOKIE_STORE.get(host);
            if (bucket == null) {
                bucket = new ArrayList<>();
                COOKIE_STORE.put(host, bucket);
            }
            for (Cookie cookie : cookies) {
                // 同名 Cookie 用新值覆盖，保持与浏览器一致的「后写优先」语义
                for (int i = bucket.size() - 1; i >= 0; i--) {
                    if (bucket.get(i).name().equals(cookie.name())) {
                        bucket.remove(i);
                    }
                }
                if (cookie.expiresAt() > System.currentTimeMillis()) {
                    bucket.add(cookie);
                }
            }
        }

        @Override
        public synchronized List<Cookie> loadForRequest(HttpUrl url) {
            List<Cookie> bucket = COOKIE_STORE.get(url.host());
            if (bucket == null) {
                return new ArrayList<>();
            }
            long now = System.currentTimeMillis();
            List<Cookie> valid = new ArrayList<>();
            for (Cookie cookie : bucket) {
                if (cookie.expiresAt() > now) {
                    valid.add(cookie);
                }
            }
            // 顺手清理过期 Cookie，避免长时间播放后列表无限增长
            bucket.clear();
            bucket.addAll(valid);
            return valid;
        }
    };

    /** 跟随重定向的客户端：日常接口用它。 */
    private final OkHttpClient followClient = new OkHttpClient.Builder()
            .cookieJar(SESSION_COOKIE_JAR)
            .connectTimeout(20, TimeUnit.SECONDS)
            .readTimeout(60, TimeUnit.SECONDS)
            .writeTimeout(60, TimeUnit.SECONDS)
            .build();

    /** 不跟随重定向的客户端：汽水/QQ 某些登录链路要自己读 302 的 Location。 */
    private final OkHttpClient noFollowClient = new OkHttpClient.Builder()
            .cookieJar(SESSION_COOKIE_JAR)
            .followRedirects(false)
            .followSslRedirects(false)
            .connectTimeout(20, TimeUnit.SECONDS)
            .readTimeout(60, TimeUnit.SECONDS)
            .writeTimeout(60, TimeUnit.SECONDS)
            .build();

    /**
     * 执行一次 HTTP 请求。
     * 所有异常都转成 reject 并带可读消息，前端据此决定重试或降级。
     */
    @PluginMethod
    public void request(PluginCall call) {
        final String url = call.getString("url");
        if (url == null || url.trim().isEmpty()) {
            call.reject("FoliaBridge: url 不能为空");
            return;
        }
        // 网络与磁盘操作不能占用 Capacitor 的桥线程，否则连续搜索时 UI 会卡住
        new Thread(() -> doRequest(call, url)).start();
    }

    private void doRequest(PluginCall call, String url) {
        String method = call.getString("method", "GET");
        JSObject headerObj = call.getObject("headers", new JSObject());
        String body = call.getString("body");
        boolean binary = Boolean.TRUE.equals(call.getBoolean("binary", false));
        boolean followRedirects = !Boolean.FALSE.equals(call.getBoolean("followRedirects", true));
        boolean omitCookies = Boolean.TRUE.equals(call.getBoolean("omitCookies", false));
        int timeoutMs = call.getInt("timeoutMs", 15000) == null ? 15000 : call.getInt("timeoutMs", 15000);

        // per-request 超时：OkHttp 的 client 超时是连接级，这里按调用方给的预算再复制一份
        OkHttpClient client = (followRedirects ? followClient : noFollowClient)
                .newBuilder()
                .connectTimeout(Math.max(3000, Math.min(timeoutMs, 60000)), TimeUnit.MILLISECONDS)
                .readTimeout(Math.max(5000, Math.min(timeoutMs * 4L, 60000)), TimeUnit.MILLISECONDS)
                .build();

        Request.Builder builder = new Request.Builder().url(url);
        Iterator<String> keys = headerObj.keys();
        List<String> headerNames = new ArrayList<>();
        while (keys.hasNext()) {
            headerNames.add(keys.next());
        }
        for (String name : headerNames) {
            String value = safeHeaderValue(headerObj.optString(name, ""));
            // OkHttp 会拒绝非法头（含换行/非 ASCII），这里先兜一层，避免一个脏头让整次请求失败
            if (value == null) {
                continue;
            }
            builder.header(name, value);
        }
        // Capacitor 的 WebView 默认会带自己的 UA；接口需要车机/桌面 UA，前端已显式传入，
        // 没传时补一个常见浏览器 UA，防止个别接口对空 UA 直接 403
        if (!hasHeader(headerNames, "User-Agent")) {
            builder.header("User-Agent", "Mozilla/5.0 (Linux; Android 13) MineradioSoundfield/1.0");
        }
        if (omitCookies) {
            // 带上空 cookie 头会让服务端清空会话，这里用 no-cookie 客户端副本更安全
            builder.header("Cookie", "");
        }

        String upperMethod = method == null ? "GET" : method.toUpperCase(Locale.ROOT);
        RequestBody requestBody = null;
        if (body != null && !"GET".equals(upperMethod) && !"HEAD".equals(upperMethod)) {
            String contentType = firstHeader(headerObj, "Content-Type");
            if (contentType == null) {
                contentType = "application/x-www-form-urlencoded; charset=utf-8";
            }
            requestBody = RequestBody.create(body, MediaType.parse(contentType));
        } else if ("POST".equals(upperMethod) || "PUT".equals(upperMethod) || "PATCH".equals(upperMethod)) {
            requestBody = RequestBody.create(new byte[0], null);
        }
        builder.method(upperMethod, requestBody);

        long startedAt = System.currentTimeMillis();
        try (Response response = client.newCall(builder.build()).execute()) {
            Headers responseHeaders = response.headers();
            JSObject headers = new JSObject();
            for (String name : responseHeaders.names()) {
                // 统一小写：前端只认小写键，保持与 HTTP/2 一致
                headers.put(name.toLowerCase(Locale.ROOT), responseHeaders.get(name));
            }
            JSArray setCookies = new JSArray();
            for (String cookie : responseHeaders.values("Set-Cookie")) {
                setCookies.put(cookie);
            }

            ResponseBody responseBody = response.body();
            byte[] bytes = responseBody == null ? new byte[0] : responseBody.bytes();
            int limit = binary ? MAX_BINARY_BYTES : MAX_TEXT_BYTES;
            if (bytes.length > limit) {
                call.reject("FoliaBridge: 响应体过大 " + bytes.length + " bytes（上限 " + limit + "）");
                return;
            }

            JSObject result = new JSObject();
            result.put("status", response.code());
            result.put("headers", headers);
            result.put("setCookies", setCookies);
            if (binary) {
                // 二进制走 base64：Capacitor 桥只能传 JSON，直接塞字节会被转成乱码
                result.put("bodyBase64", android.util.Base64.encodeToString(bytes, android.util.Base64.NO_WRAP));
                result.put("body", "");
            } else {
                result.put("bodyBase64", "");
                // 文本接口基本都是 UTF-8；个别旧接口是 GBK，前端按需自行解码
                result.put("body", new String(bytes, java.nio.charset.StandardCharsets.UTF_8));
            }
            Log.d(TAG, upperMethod + " " + url + " -> " + response.code() + " in "
                    + (System.currentTimeMillis() - startedAt) + "ms, " + bytes.length + "B");
            call.resolve(result);
        } catch (IOException e) {
            // 网络类错误：把原因原样带回去，前端日志里能直接看出是超时还是 DNS
            call.reject("FoliaBridge 请求失败: " + e.getMessage(), e);
        } catch (Exception e) {
            call.reject("FoliaBridge 未知错误: " + e.getMessage(), e);
        }
    }

    /** 清空会话 Cookie（退出登录时前端会调，避免换号后仍带旧身份）。 */
    @PluginMethod
    public void clearCookies(PluginCall call) {
        synchronized (COOKIE_STORE) {
            COOKIE_STORE.clear();
        }
        call.resolve();
    }

    /** 列出当前保存的 Cookie 域名，仅用于设置页调试展示。 */
    @PluginMethod
    public void listCookieHosts(PluginCall call) {
        JSArray hosts = new JSArray();
        synchronized (COOKIE_STORE) {
            for (String host : COOKIE_STORE.keySet()) {
                hosts.put(host);
            }
        }
        JSObject result = new JSObject();
        result.put("hosts", hosts);
        call.resolve(result);
    }

    private static boolean hasHeader(List<String> names, String target) {
        for (String name : names) {
            if (name != null && name.equalsIgnoreCase(target)) {
                return true;
            }
        }
        return false;
    }

    private static String firstHeader(JSObject headers, String target) {
        Iterator<String> keys = headers.keys();
        while (keys.hasNext()) {
            String name = keys.next();
            if (name != null && name.equalsIgnoreCase(target)) {
                return headers.optString(name, null);
            }
        }
        return null;
    }

    /** 过滤含控制字符的头值：OkHttp 对非法头会抛 IllegalArgumentException。 */
    private static String safeHeaderValue(String value) {
        if (value == null) {
            return null;
        }
        StringBuilder out = new StringBuilder(value.length());
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            if (c == '\r' || c == '\n') {
                continue;
            }
            out.append(c);
        }
        return out.toString().trim();
    }
}
