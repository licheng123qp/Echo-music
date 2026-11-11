// 全平台音频缓存：任何平台「播过一次」的歌，下次（包括重启 App 之后）直接读本地文件秒播。
//
// 为什么需要它：
//   汽水 / 网易云 / QQ / 酷狗这些平台每次播放都要先请求一次「取播放地址」的接口，
//   汽水那套接口实测经常 5~20 秒才回一个地址，于是「点一首歌等半天」。
//   音频本身是固定的，只要把字节缓存到本地，第二次播放完全可以零请求直接起播。
//
// 设计要点：
//   1. **先查缓存再取地址**：命中就直接用本地流地址，连 /api/<平台>/song/url 都不发；
//   2. **首次播放不拖慢**：没命中时照常走原来的取址流程，播放开始后在后台悄悄下载缓存，
//      不阻塞起播、失败也不影响播放；
//   3. 缓存键用「平台 + 稳定歌曲 id」，与平台直链里的 expire/sign 无关，重启后仍然有效；
//   4. 原生侧按真实音频格式落盘（mp3/m4a/flac…），并用总容量上限做 LRU 清理。

var MR_AUDIO_CACHE_SETTINGS_KEY = 'mineradio-audio-cache-v1';
var MR_AUDIO_CACHE_PREFIX = 'mr:';
var MR_AUDIO_CACHE_WARM_LIMIT = 2;

var mrAudioCacheState = {
  enabled: true,
  warming: {},      // key → true，避免同一首歌重复下载
  queue: [],
  active: 0,
  hits: 0,
  misses: 0
};

(function mrAudioCacheLoadSettings() {
  try {
    var raw = window.localStorage && window.localStorage.getItem(MR_AUDIO_CACHE_SETTINGS_KEY);
    var data = raw ? JSON.parse(raw) : null;
    if (data && typeof data.enabled === 'boolean') mrAudioCacheState.enabled = data.enabled;
  } catch (_error) { /* 读不到就用默认：开启 */ }
})();

function mrAudioCacheSaveSettings() {
  try {
    if (window.localStorage) {
      window.localStorage.setItem(MR_AUDIO_CACHE_SETTINGS_KEY, JSON.stringify({ enabled: !!mrAudioCacheState.enabled }));
    }
  } catch (_error) { /* 忽略 */ }
}

function mrAudioCachePlugin() {
  var cap = window.Capacitor;
  return (cap && cap.Plugins && cap.Plugins.FoliaNative) || null;
}

/** 这些平台各自「稳定的歌曲 id」字段不一样，统一取出一个可做缓存键的值。 */
function mrAudioCacheSongId(provider, song) {
  song = song || {};
  if (provider === 'kugou') return song.hash || song.fileHash || song.audioHash || song.id || '';
  if (provider === 'qq') return song.mid || song.songmid || song.mediaMid || song.id || '';
  if (provider === 'bodian') return song.rid || song.id || '';
  if (provider === 'spotify') return song.spotifyId || song.id || '';
  return song.id || song.providerSongId || '';
}

function mrAudioCacheKey(provider, song) {
  var id = String(mrAudioCacheSongId(provider, song) || '').trim();
  if (!id) return '';
  return MR_AUDIO_CACHE_PREFIX + provider + ':' + id;
}

/** 这些平台不会走通用缓存：YouTube 自己有按 videoId 的缓存；Spotify 是受保护音频。 */
function mrAudioCacheProviderSupported(provider) {
  return provider === 'netease' || provider === 'qq' || provider === 'kugou' || provider === 'qishui' || provider === 'bodian';
}

function mrAudioCacheHeaders(provider) {
  var headers = {
    'User-Agent': navigator.userAgent,
    'Accept': '*/*'
  };
  if (provider === 'netease') headers.Referer = 'https://music.163.com/';
  else if (provider === 'qq') headers.Referer = 'https://y.qq.com/';
  else if (provider === 'kugou') headers.Referer = 'https://www.kugou.com/';
  else if (provider === 'qishui') headers.Referer = 'https://www.douyin.com/';
  else if (provider === 'bodian') headers.Referer = 'https://www.kuwo.cn/';
  return headers;
}

function mrAudioCacheIsLocalUrl(url) {
  return /^https?:\/\/(127\.0\.0\.1|localhost)(:|\/)/i.test(String(url || ''));
}

/** 只查本地缓存（不联网）：命中返回本地流地址，没命中返回空串。 */
async function mrAudioCacheLookup(provider, song) {
  if (!mrAudioCacheState.enabled) return '';
  if (!mrAudioCacheProviderSupported(provider)) return '';
  var key = mrAudioCacheKey(provider, song);
  if (!key) return '';
  var plugin = mrAudioCachePlugin();
  if (!plugin || typeof plugin.getCachedAudio !== 'function') return '';
  try {
    var hit = await plugin.getCachedAudio({ key: key });
    if (hit && hit.url) {
      mrAudioCacheState.hits += 1;
      console.log('[AudioCache] 命中本地缓存，直接起播：' + key);
      return String(hit.url);
    }
  } catch (error) {
    console.warn('[AudioCache] 查缓存失败：' + (error && error.message || error));
  }
  mrAudioCacheState.misses += 1;
  return '';
}

/**
 * 后台把这首歌下载成缓存文件（不阻塞当前播放）。
 * 只在「播放确实开始了」之后调用，失败就静默 —— 缓存是加分项，不能影响听歌。
 */
function mrAudioCacheWarm(provider, song, remoteUrl) {
  if (!mrAudioCacheState.enabled) return false;
  if (!mrAudioCacheProviderSupported(provider)) return false;
  if (!remoteUrl || mrAudioCacheIsLocalUrl(remoteUrl)) return false;
  var key = mrAudioCacheKey(provider, song);
  if (!key) return false;
  if (mrAudioCacheState.warming[key]) return false;
  var plugin = mrAudioCachePlugin();
  if (!plugin || typeof plugin.registerCachedAudio !== 'function') return false;
  if (mrAudioCacheState.queue.length > 8) return false; // 队列太长说明网络本来就慢，别再加负担
  mrAudioCacheState.warming[key] = true;
  mrAudioCacheState.queue.push({ key: key, url: String(remoteUrl), headers: mrAudioCacheHeaders(provider) });
  mrAudioCachePump();
  return true;
}

function mrAudioCachePump() {
  while (mrAudioCacheState.active < MR_AUDIO_CACHE_WARM_LIMIT && mrAudioCacheState.queue.length) {
    var job = mrAudioCacheState.queue.shift();
    mrAudioCacheState.active += 1;
    var plugin = mrAudioCachePlugin();
    var startedAt = Date.now();
    Promise.resolve(plugin.registerCachedAudio({ key: job.key, url: job.url, headers: job.headers }))
      .then(function (result) {
        if (result && result.url) {
          console.log('[AudioCache] 已缓存 ' + job.key + '（' + (Date.now() - startedAt) + 'ms）');
        }
      })
      .catch(function (error) {
        console.warn('[AudioCache] 缓存失败 ' + job.key + '：' + (error && error.message || error));
      })
      .then(function () {
        mrAudioCacheState.active -= 1;
        delete mrAudioCacheState.warming[job.key];
        mrAudioCachePump();
      });
  }
}

/**
 * 播放主流程用的入口：先查缓存，返回 { data, cached }。
 * data 为空表示没命中，调用方继续走原来的取址流程。
 */
async function mrAudioCacheResolve(provider, song) {
  var localUrl = await mrAudioCacheLookup(provider, song);
  if (!localUrl) return null;
  return {
    provider: provider,
    url: localUrl,
    level: (song && (song.playbackLevel || song.level)) || 'standard',
    cached: true,
    sourceMatch: true
  };
}

function setMrAudioCacheEnabled(enabled) {
  mrAudioCacheState.enabled = !!enabled;
  mrAudioCacheSaveSettings();
  if (typeof showToast === 'function') showToast(mrAudioCacheState.enabled ? '已开启全平台播放缓存' : '已关闭全平台播放缓存');
  return mrAudioCacheState.enabled;
}

function mrAudioCacheStats() {
  return {
    enabled: mrAudioCacheState.enabled,
    hits: mrAudioCacheState.hits,
    misses: mrAudioCacheState.misses,
    pending: mrAudioCacheState.queue.length + mrAudioCacheState.active
  };
}