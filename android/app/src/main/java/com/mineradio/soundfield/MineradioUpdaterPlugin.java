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
            pendingFile = target;
            call.setKeepAlive(true);
            registerDownloadReceiver(manager);
        } catch (Exception e) {
            call.reject("下载启动失败: " + e.getMessage(), e);
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
                if (id != downloadId) return;

                PluginCall call = pendingCall;
                pendingCall = null;
                long finishedId = downloadId;
                downloadId = -1;

                // 广播只说明「任务结束」，成功还是失败要查 DownloadManager
                DownloadManager.Query query = new DownloadManager.Query().setFilterById(finishedId);
                int status = DownloadManager.STATUS_FAILED;
                try (android.database.Cursor cursor = manager.query(query)) {
                    if (cursor != null && cursor.moveToFirst()) {
                        status = cursor.getInt(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS));
                    }
                } catch (Exception ignored) {
                    // 查询失败按失败处理，避免前端一直转圈
                }

                if (call == null) return;
                if (status == DownloadManager.STATUS_SUCCESSFUL) {
                    File file = pendingFile;
                    JSObject result = new JSObject();
                    result.put("status", "completed");
                    result.put("path", file != null ? file.getAbsolutePath() : "");
                    // 安装器打不开不算下载失败：把错误回传给前端提示「手动安装」，
                    // 但一次调用只能有一个结果，所以先装、再一次性 resolve。
                    if (file != null && file.exists()) {
                        try {
                            launchInstaller(file);
                        } catch (Exception e) {
                            result.put("installError", String.valueOf(e.getMessage()));
                        }
                    }
                    call.resolve(result);
                } else {
                    call.reject("下载失败（状态码 " + status + "）");
                }
            }
        };
        IntentFilter filter = new IntentFilter(DownloadManager.ACTION_DOWNLOAD_COMPLETE);
        // RECEIVER_NOT_EXPORTED：Android 13+ 强制要求声明导出性；系统下载完成广播仍能收到
        ContextCompat.registerReceiver(getContext(), downloadReceiver, filter, ContextCompat.RECEIVER_NOT_EXPORTED);
    }

    @Override
    protected void handleOnDestroy() {
        try {
            if (downloadReceiver != null) getContext().unregisterReceiver(downloadReceiver);
        } catch (Exception ignored) {
            // 没注册成功或已注销，忽略
        }
        downloadReceiver = null;
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
