package com.mineradio.soundfield;

import android.app.DownloadManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.net.Uri;
import android.os.Environment;

import androidx.core.content.ContextCompat;
import androidx.core.content.FileProvider;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;

/**
 * MineradioUpdater：应用内检查更新后的「下载 + 安装」能力。
 *
 * 为什么不让 WebView 自己下：<a> 下载在 WebView 里拿不到文件，也无法调起系统安装器；
 * 这里用系统 DownloadManager 下载到应用私有目录（external-files/Download），
 * 完成后再用 FileProvider 生成 content:// URI 交给系统安装器。
 *
 * 与前端契约（www/js/soundfield/30-update.js）：
 *   getAppInfo()                    → { versionName, versionCode, packageName }
 *   downloadAndInstall({url, fileName, title, autoInstall}) → { status, path }
 *   openExternal({url})             → 用系统浏览器打开
 */
@CapacitorPlugin(name = "MineradioUpdater")
public class MineradioUpdaterPlugin extends Plugin {

    /** 当前下载任务的 id；-1 表示没有进行中的任务。 */
    private long downloadId = -1;

    /** 下载期间挂起的调用，完成/失败时回复。 */
    private PluginCall pendingCall;

    /** 进度轮询：DownloadManager 没有进度回调，只能定时查。 */
    private final android.os.Handler progressHandler = new android.os.Handler(android.os.Looper.getMainLooper());
    private Runnable progressTask;

    /** 停滞检测用的基线：多久没收到新字节就判定为卡死。 */
    private static final long STALL_TIMEOUT_MS = 90_000;
    private long lastReceivedBytes = 0;
    private long lastProgressAt = 0;

    /** 下载完成后要安装的文件。 */
    private File pendingFile;

    private BroadcastReceiver downloadReceiver;

    /** 返回应用版本信息：前端用它和 GitHub Release 的 tag 比较。 */
    @PluginMethod
    public void getAppInfo(PluginCall call) {
        JSObject result = new JSObject();
        try {
            // 直接查 PackageManager：不依赖 AGP 的 BuildConfig 生成开关，
            // 拿到的就是安装包 manifest 里的 versionName/versionCode，最可信
            android.content.pm.PackageInfo info = getContext().getPackageManager()
                    .getPackageInfo(getContext().getPackageName(), 0);
            result.put("versionName", info.versionName == null ? "" : info.versionName);
            if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.P) {
                result.put("versionCode", info.getLongVersionCode());
            } else {
                result.put("versionCode", info.versionCode);
            }
        } catch (Exception e) {
            result.put("versionName", "");
            result.put("versionCode", 0);
        }
        result.put("packageName", getContext().getPackageName());
        call.resolve(result);
    }

    /** 用系统浏览器打开链接（权限被拒、下载器不可用时的兜底）。 */
    @PluginMethod
    public void openExternal(PluginCall call) {
        String url = call.getString("url");
        if (url == null || url.trim().isEmpty()) {
            call.reject("url 不能为空");
            return;
        }
        try {
            Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
            call.resolve();
        } catch (Exception e) {
            // 车机可能没有浏览器，把原因带回去让前端提示
            call.reject("无法打开链接: " + e.getMessage(), e);
        }
    }

    /**
     * 下载更新包并在完成后调起安装器。
     * autoInstall=false 时只下载，由前端再调 install()。
     */
    @PluginMethod
    public void downloadAndInstall(final PluginCall call) {
        final String url = call.getString("url");
        if (url == null || url.trim().isEmpty()) {
            call.reject("下载地址为空");
            return;
        }
        if (pendingCall != null) {
            call.reject("已有更新在下载中");
            return;
        }
        final String fileName = sanitizeFileName(call.getString("fileName", "EchoMusic-update.apk"));
        final String title = call.getString("title", "Mineradio 声场版更新");
        final boolean autoInstall = !Boolean.FALSE.equals(call.getBoolean("autoInstall", true));

        try {
            DownloadManager manager = (DownloadManager) getContext().getSystemService(Context.DOWNLOAD_SERVICE);
            if (manager == null) {
                call.reject("系统下载服务不可用");
                return;
            }
            File dir = getContext().getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
            if (dir == null) {
                call.reject("无法创建下载目录");
                return;
            }
            // 同名旧包先删掉，避免 DownloadManager 直接改名成 xxx-1.apk 导致后续安装的是旧文件
            File target = new File(dir, fileName);
            if (target.exists() && !target.delete()) {
                call.reject("旧安装包删除失败，请手动清理下载目录");
                return;
            }

            DownloadManager.Request request = new DownloadManager.Request(Uri.parse(url))
                    .setTitle(title)
                    .setDescription("正在下载 " + fileName)
                    .setMimeType("application/vnd.android.package-archive")
                    .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                    .setDestinationInExternalFilesDir(getContext(), Environment.DIRECTORY_DOWNLOADS, fileName);
            // 车机网络抖动时允许断点续传，避免几十 MB 白下
            request.setAllowedOverMetered(true);
            request.setAllowedOverRoaming(true);

            downloadId = manager.enqueue(request);
            pendingCall = call;
            startProgressPolling(manager);
            pendingFile = target;
            call.setKeepAlive(true);
            registerDownloadReceiver(manager);
        } catch (Exception e) {
            call.reject("下载启动失败: " + e.getMessage(), e);
        }
    }

    /**
     * 每 500ms 查一次下载进度并推给前端。
     * 事件名 progress，载荷 { received, total, percent }；
     * percent 在总大小未知时为 -1，前端据此只显示「正在下载」。
     */
    private void startProgressPolling(final DownloadManager manager) {
        stopProgressPolling();
        lastReceivedBytes = 0;
        lastProgressAt = System.currentTimeMillis();
        progressTask = new Runnable() {
            @Override
            public void run() {
                long id = downloadId;
                if (id <= 0) return;
                long received = 0;
                long total = 0;
                int status = DownloadManager.STATUS_RUNNING;
                DownloadManager.Query query = new DownloadManager.Query().setFilterById(id);
                try (android.database.Cursor cursor = manager.query(query)) {
                    if (cursor != null && cursor.moveToFirst()) {
                        received = cursor.getLong(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_BYTES_DOWNLOADED_SO_FAR));
                        total = cursor.getLong(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_TOTAL_SIZE_BYTES));
                        status = cursor.getInt(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS));
                    }
                } catch (Exception ignored) {
                    // 查询失败就停一轮，下一轮再试
                }
                // ★ 完成判定放在轮询里，不依赖广播：
                //   DownloadManager 的完成广播由系统进程发出，Android 13+ 用 RECEIVER_NOT_EXPORTED
                //   注册会收不到，前端就会一直停在「下载中」。轮询是同一份数据，最可靠。
                if (status == DownloadManager.STATUS_SUCCESSFUL) {
                    completeDownload();
                    return;
                }
                if (status == DownloadManager.STATUS_FAILED) {
                    failDownload("下载失败（系统状态 " + status + "），请检查网络后重试");
                    return;
                }

                // 停滞检测：车机网络断开时状态会一直是 RUNNING、字节不再增长
                long now = System.currentTimeMillis();
                if (received > lastReceivedBytes) {
                    lastReceivedBytes = received;
                    lastProgressAt = now;
                }
                if (lastProgressAt > 0 && now - lastProgressAt > STALL_TIMEOUT_MS) {
                    failDownload("下载超时：90 秒没有收到数据，请检查网络后重试，或打开发布页手动下载");
                    return;
                }

                JSObject payload = new JSObject();
                payload.put("received", received);
                payload.put("total", total);
                payload.put("percent", total > 0 ? Math.round(received * 1000.0 / total) / 10.0 : -1);
                notifyListeners("progress", payload);
                progressHandler.postDelayed(this, 500);
            }
        };
        progressHandler.post(progressTask);
    }

    /** 停止进度轮询（下载结束或页面销毁时调用）。 */
    private void stopProgressPolling() {
        if (progressTask != null) {
            progressHandler.removeCallbacks(progressTask);
            progressTask = null;
        }
    }

    /** 手动安装已下载好的包（autoInstall=false 的场景）。 */
    @PluginMethod
    public void install(PluginCall call) {
        String path = call.getString("path");
        File file = path != null ? new File(path) : pendingFile;
        if (file == null || !file.exists()) {
            call.reject("安装包不存在");
            return;
        }
        try {
            launchInstaller(file);
            call.resolve();
        } catch (Exception e) {
            call.reject("无法调起安装器: " + e.getMessage(), e);
        }
    }

    /** 调起系统安装器；未知来源权限未开时系统会自动弹设置页。 */
    private void launchInstaller(File file) {
        Uri uri = FileProvider.getUriForFile(
                getContext(),
                getContext().getPackageName() + ".fileprovider",
                file);
        Intent intent = new Intent(Intent.ACTION_VIEW);
        intent.setDataAndType(uri, "application/vnd.android.package-archive");
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(intent);
    }

    /** 注册下载完成广播；Android 13+ 必须显式声明导出性。 */
    private void registerDownloadReceiver(final DownloadManager manager) {
        downloadReceiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context context, Intent intent) {
                long id = intent.getLongExtra(DownloadManager.EXTRA_DOWNLOAD_ID, -1);
                if (id <= 0 || id != downloadId) return;
                // 拿到广播再查一次状态，避免和轮询互相抢先
                int status = queryStatus(manager, id);
                if (status == DownloadManager.STATUS_SUCCESSFUL) {
                    completeDownload();
                } else if (status == DownloadManager.STATUS_FAILED) {
                    failDownload("下载失败（系统状态 " + status + "）");
                }
            }
        };
        IntentFilter filter = new IntentFilter(DownloadManager.ACTION_DOWNLOAD_COMPLETE);
        // ★ 必须 EXPORTED：完成广播来自系统 DownloadProvider（不同 UID），
        //   NOT_EXPORTED 会静默丢弃，表现为前端永远「下载中」。
        ContextCompat.registerReceiver(getContext(), downloadReceiver, filter, ContextCompat.RECEIVER_EXPORTED);
    }

    /** 查一次下载状态；查不到按失败处理。 */
    private int queryStatus(DownloadManager manager, long id) {
        DownloadManager.Query query = new DownloadManager.Query().setFilterById(id);
        try (android.database.Cursor cursor = manager.query(query)) {
            if (cursor != null && cursor.moveToFirst()) {
                return cursor.getInt(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS));
            }
        } catch (Exception ignored) {
            // 落到下面的失败分支
        }
        return DownloadManager.STATUS_FAILED;
    }

    /** 下载完成：回复前端并调起安装器。 */
    private void completeDownload() {
        PluginCall call = pendingCall;
        pendingCall = null;
        downloadId = -1;
        stopProgressPolling();
        if (call == null) return;
        File file = pendingFile;
        JSObject result = new JSObject();
        result.put("status", "completed");
        result.put("path", file != null ? file.getAbsolutePath() : "");
        if (file != null && file.exists()) {
            try {
                launchInstaller(file);
            } catch (Exception e) {
                // 安装器打不开不算下载失败：前端据此提示「手动安装」
                result.put("installError", String.valueOf(e.getMessage()));
            }
        }
        call.resolve(result);
    }

    /** 下载失败/超时：结束挂起调用，让前端显示错误与兜底按钮。 */
    private void failDownload(String message) {
        PluginCall call = pendingCall;
        pendingCall = null;
        downloadId = -1;
        stopProgressPolling();
        if (call != null) call.reject(message);
    }

    @Override
    protected void handleOnDestroy() {
        try {
            if (downloadReceiver != null) getContext().unregisterReceiver(downloadReceiver);
        } catch (Exception ignored) {
            // 没注册成功或已注销，忽略
        }
        downloadReceiver = null;
        stopProgressPolling();
        if (pendingCall != null) {
            pendingCall.reject("页面已关闭，下载被取消");
            pendingCall = null;
        }
        super.handleOnDestroy();
    }

    /** 文件名只保留安全字符：下载路径直接来自网络，必须防目录穿越。 */
    private static String sanitizeFileName(String name) {
        String cleaned = name == null ? "" : name.replaceAll("[^A-Za-z0-9._-]", "_");
        if (cleaned.isEmpty() || !cleaned.toLowerCase().endsWith(".apk")) {
            cleaned = "EchoMusic-update.apk";
        }
        return cleaned;
    }
}
