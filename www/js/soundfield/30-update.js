// public/js/soundfield/30-update.js
// 应用内「检查更新」：查 GitHub Release → 原生下载 → 系统安装器。
//
// 为什么不用网页自己下载：
//   WebView 里的 <a download> 落不到可访问的目录，也调不起系统安装器；
//   所以下载交给原生 DownloadManager（见 MineradioUpdaterPlugin.java），
//   前端只负责「比较版本 + 展示 + 触发」。
//
// 网络层复用 android-shim 的原生桥（__mrBridgeRequest）：api.github.com 不带 CORS 头，
// 在 https://localhost 页面里直接 fetch 会被拦。

(function (root) {
  'use strict';

  /** 更新来源仓库；换仓库只改这里。 */
  var REPO = 'licheng123qp/Echo-music';
  var API_LATEST = 'https://api.github.com/repos/' + REPO + '/releases/latest';
  var RELEASES_PAGE = 'https://github.com/' + REPO + '/releases/latest';

  /** 自动检查的节流：24 小时内不重复请求 GitHub API（匿名额度只有 60 次/小时）。 */
  var AUTO_INTERVAL_MS = 24 * 60 * 60 * 1000;
  var CACHE_KEY = 'mineradio-update-cache-v1';

  /** 模块状态：面板每次打开读它渲染，不重复发请求。 */
  var state = {
    checking: false,
    current: null,        // { versionName, versionCode }
    latest: null,         // { tag, version, notes, apkUrl, apkName, apkSize, htmlUrl }
    error: '',
    lastCheckAt: 0,
  };

  /** 原生插件（下载/安装、读版本号）；网页预览里为 null。 */
  function plugin() {
    var cap = root.Capacitor;
    return (cap && cap.Plugins && cap.Plugins.MineradioUpdater) || null;
  }

  /** 读缓存：上次检查结果，避免每次开面板都打 GitHub API。 */
  function readCache() {
    try {
      var raw = localStorage.getItem(CACHE_KEY);
      if (!raw) return null;
      var parsed = JSON.parse(raw);
      if (!parsed || !parsed.latest || !parsed.at) return null;
      return parsed;
    } catch (e) {
      return null;
    }
  }

  /** 写缓存；存不下不影响功能。 */
  function writeCache(payload) {
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify(payload));
    } catch (e) { /* ignore */ }
  }

  /**
   * 读应用版本。
   * 优先问原生（BuildConfig.VERSION_NAME），拿不到时返回 null，
   * 前端就会显示「未知版本」并跳过「是否最新」的判断，而不是误报。
   */
  async function getAppInfo() {
    if (state.current) return state.current;
    var p = plugin();
    if (p && typeof p.getAppInfo === 'function') {
      try {
        var info = await p.getAppInfo();
        state.current = {
          versionName: String(info && info.versionName || ''),
          versionCode: Number(info && info.versionCode || 0),
        };
        return state.current;
      } catch (e) {
        console.warn('[Updater] 读取版本失败', e);
      }
    }
    return null;
  }

  /** 把 "v2.2.0-sf3" 解析成可比较结构；读不出返回 null。 */
  function parseVersion(raw) {
    var text = String(raw || '').trim().replace(/^v/i, '');
    var match = text.match(/^(\d+)\.(\d+)\.(\d+)(?:-([a-z]+)(\d+))?/i);
    if (!match) return null;
    return {
      major: Number(match[1]),
      minor: Number(match[2]),
      patch: Number(match[3]),
      pre: match[4] ? match[4].toLowerCase() : '',
      preNum: match[5] ? Number(match[5]) : 0,
    };
  }

  /** 比较版本：a 比 b 新返回正数，相同 0，旧返回负数。 */
  function compareVersion(a, b) {
    var pa = typeof a === 'string' ? parseVersion(a) : a;
    var pb = typeof b === 'string' ? parseVersion(b) : b;
    if (!pa || !pb) return 0; // 解析不了就当相同，宁可不打扰用户
    var keys = ['major', 'minor', 'patch'];
    for (var i = 0; i < keys.length; i++) {
      if (pa[keys[i]] !== pb[keys[i]]) return pa[keys[i]] - pb[keys[i]];
    }
    // 正式版（无后缀）比预发布版新：2.2.0 > 2.2.0-sf3
    if (pa.pre !== pb.pre) {
      if (!pa.pre) return 1;
      if (!pb.pre) return -1;
      return pa.pre < pb.pre ? 1 : -1;
    }
    return pa.preNum - pb.preNum;
  }

  /**
   * 统一请求：优先走原生桥（绕 CORS），网页环境退回 fetch。
   * @returns {Promise<object|null>} 404 返回 null，其它错误抛出
   */
  async function requestJson(url) {
    var bridge = root.__mrBridgeRequest;
    if (typeof bridge === 'function') {
      try {
        var answer = await bridge({
          url: url,
          method: 'GET',
          headers: {
            Accept: 'application/vnd.github+json',
            'User-Agent': 'Mineradio-SoundField',
          },
          timeoutMs: 15000,
        });
        if (answer.status === 404) return null;
        if (answer.status < 200 || answer.status >= 300) {
          throw new Error('GitHub API HTTP ' + answer.status);
        }
        return JSON.parse(answer.body || '{}');
      } catch (bridgeError) {
        // 原生桥没注册（网页预览）或桥本身报错时退回 fetch：
        // api.github.com 带 CORS 头，浏览器直连也能拿到结果，只是没用原生代理。
        console.warn('[Updater] 原生桥不可用，改用 fetch', bridgeError && bridgeError.message);
      }
    }
    var response = await fetch(url, {
      headers: { Accept: 'application/vnd.github+json' },
    });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error('GitHub API HTTP ' + response.status);
    return response.json();
  }

  /** 从 Release JSON 里挑出 APK 资产（优先包含当前包名前缀的）。 */
  function pickApkAsset(release) {
    var assets = (release && release.assets) || [];
    var apks = assets.filter(function (asset) {
      return /\.apk$/i.test(asset.name || '');
    });
    if (!apks.length) return null;
    // 我们的产物命名是 EchoMusic-<版本>.apk，取第一个即可
    return apks[0];
  }

  /** 拉取最新 Release 并归一化成前端好用的结构。 */
  async function fetchLatest() {
    var release = await requestJson(API_LATEST);
    if (!release) return null;
    var apk = pickApkAsset(release);
    return {
      tag: String(release.tag_name || ''),
      version: parseVersion(release.tag_name),
      notes: String(release.body || ''),
      publishedAt: String(release.published_at || ''),
      htmlUrl: String(release.html_url || RELEASES_PAGE),
      apkUrl: apk ? String(apk.browser_download_url || '') : '',
      apkName: apk ? String(apk.name || '') : '',
      apkSize: apk ? Number(apk.size || 0) : 0,
    };
  }

  /**
   * 检查更新。
   * @param {object} [options] { force: 跳过 24h 缓存, silent: 不弹提示 }
   * @returns {Promise<{hasUpdate:boolean, latest:object|null, current:object|null, error:string}>}
   */
  async function check(options) {
    var opts = options || {};
    if (state.checking) return result();
    state.checking = true;
    state.error = '';

    try {
      var current = await getAppInfo();
      var cached = readCache();
      var fresh = opts.force || !cached || (Date.now() - Number(cached.at || 0) > AUTO_INTERVAL_MS);
      var latest = fresh ? await fetchLatest() : cached.latest;

      if (fresh && latest) {
        writeCache({ at: Date.now(), latest: latest });
        state.lastCheckAt = Date.now();
      }
      state.latest = latest || null;
      if (!latest) {
        state.error = '还没有发布版本';
      }
    } catch (e) {
      state.error = '检查失败：' + (e && e.message ? e.message : '网络异常');
    } finally {
      state.checking = false;
    }
    return result();
  }

  /** 汇总一次检查结果，供面板与外部调用。 */
  function result() {
    var current = state.current;
    var latest = state.latest;
    var hasUpdate = !!(current && latest && compareVersion(latest.tag, current.versionName) > 0);
    return {
      hasUpdate: hasUpdate,
      latest: latest,
      current: current,
      error: state.error,
      checking: state.checking,
    };
  }

  /**
   * 下载并调起安装。
   * 没有原生插件（网页预览）时退回到打开 Release 页面。
   * @returns {Promise<{status:string, path?:string}>}
   */
  async function download() {
    var latest = state.latest;
    if (!latest) throw new Error('尚未检查到新版本');
    var p = plugin();
    if (!p || typeof p.downloadAndInstall !== 'function') {
      if (typeof p.openExternal === 'function') {
        await p.openExternal({ url: latest.htmlUrl });
        return { status: 'opened' };
      }
      window.open(latest.htmlUrl, '_blank');
      return { status: 'opened' };
    }
    return p.downloadAndInstall({
      url: latest.apkUrl || latest.htmlUrl,
      fileName: latest.apkName || 'EchoMusic-update.apk',
      title: 'Mineradio 声场版 ' + (latest.tag || ''),
      autoInstall: true,
    });
  }

  /** 打开 Release 页面（用户在应用里装不了时的兜底）。 */
  async function openReleasePage() {
    var url = (state.latest && state.latest.htmlUrl) || RELEASES_PAGE;
    var p = plugin();
    if (p && typeof p.openExternal === 'function') {
      await p.openExternal({ url: url });
      return;
    }
    window.open(url, '_blank');
  }

  /** 版本号展示用：拿不到就显示「未知」。 */
  function currentVersionLabel() {
    return state.current && state.current.versionName ? state.current.versionName : '未知';
  }

  /** 0.4 MB → "0.4 MB"；用于面板展示安装包大小。 */
  function formatSize(bytes) {
    var n = Number(bytes) || 0;
    if (n <= 0) return '';
    if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB';
    return (n / 1024 / 1024).toFixed(1) + ' MB';
  }

  root.MRUpdater = {
    check: check,
    download: download,
    openReleasePage: openReleasePage,
    getAppInfo: getAppInfo,
    currentVersionLabel: currentVersionLabel,
    compareVersion: compareVersion,
    formatSize: formatSize,
    getState: function () { return result(); },
    // 调试用
    _state: state,
  };
})(window);
