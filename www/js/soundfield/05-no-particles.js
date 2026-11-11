// public/js/soundfield/05-no-particles.js
// 关闭 3D 粒子层（封面点阵、辉光、星空、骷髅/背板、歌词粒子、Sonic 地形）。
//
// 为什么单独做一层而不是改上游代码：
//   粒子系统散落在 6 个模块里，每处都改会制造大量 diff，升级上游时全是冲突。
//   这里在 THREE.Points 构造处统一拦截：凡是粒子对象，创建时就标记为不可见 +
//   drawRange=0（GPU 不画任何顶点），并把每帧更新函数包一层开关。
//   想恢复原效果：面板里把「粒子效果」切回「开」，或 localStorage
//   mineradio-particles-enabled-v1 = '1'。
//
// 注意：本模块必须在 js/index-loader.js **之前**加载，才能抢在上游建粒子之前包住 THREE.Points。

(function (root) {
  'use strict';

  var STORAGE_KEY = 'mineradio-particles-enabled-v1';

  /** 是否启用粒子；默认关闭（车机 CPU 优先）。 */
  var enabled = false;
  try {
    enabled = localStorage.getItem(STORAGE_KEY) === '1';
  } catch (e) {
    enabled = false;
  }

  /** 已创建的粒子对象，切换开关时统一处理。 */
  var registry = [];

  /** 记一下每个粒子原本的可见性，恢复时尽量还原。 */
  function track(points) {
    if (!points || !points.isPoints) return points;
    if (registry.indexOf(points) === -1) registry.push(points);
    lockVisibility(points);
    if (!enabled) {
      applyDrawRange(points);
    }
    return points;
  }

  /**
   * 锁住 visible。
   * 上游主循环每帧都会写 `particles.visible = ...`（按预设切换），
   * 单纯设一次 false 会被下一帧覆盖掉，所以这里把实例的 visible 改成
   * 「写进去照收、读出来在关闭态下恒为 false」，既不影响上游逻辑，又能真正不画。
   */
  function lockVisibility(points) {
    if (!points || points.__mrVisibilityLocked) return;
    var descriptor = Object.getOwnPropertyDescriptor(points, 'visible');
    var realValue = descriptor ? descriptor.value : points.visible;
    try {
      Object.defineProperty(points, 'visible', {
        configurable: true,
        enumerable: true,
        get: function () { return enabled ? realValue : false; },
        set: function (value) { realValue = value; },
      });
      points.__mrVisibilityLocked = true;
    } catch (e) {
      // 极端情况下（对象被冻结）退化为直接赋值
      points.visible = enabled;
    }
  }

  /** 关掉时把绘制范围设为 0：GPU 不遍历顶点，比重建 geometry 安全得多。 */
  function applyDrawRange(points) {
    var geo = points && points.geometry;
    if (!geo) return;
    var attr = geo.attributes && (geo.attributes.position || geo.attributes.aPosition);
    var count = attr && attr.count ? attr.count : 0;
    try {
      geo.setDrawRange(0, enabled ? count : 0);
      // 关掉后不需要每帧重新上传包围球，减少一次计算
      if (!enabled && geo.boundingSphere === null) {
        geo.boundingSphere = { center: { x: 0, y: 0, z: 0 }, radius: 1 };
      }
    } catch (e) {
      // 个别自定义 geometry 没实现 setDrawRange，忽略即可
    }
  }

  // ── 1. 拦截 THREE.Points 构造 ────────────────────────────────
  var three = root.THREE;
  if (three && typeof three.Points === 'function' && !three.Points.__mrParticlePatched) {
    var OriginalPoints = three.Points;
    var PointsProxy = function (geometry, material) {
      var points = new OriginalPoints(geometry, material);
      track(points);
      return points;
    };
    // 保留原型链，外部 instanceof THREE.Points 仍然成立
    PointsProxy.prototype = OriginalPoints.prototype;
    PointsProxy.__mrParticlePatched = true;
    three.Points = PointsProxy;
  }

  /**
   * 把每帧的粒子更新函数包一层：关闭时直接返回，连顶点属性都不算。
   * 用全局函数名替换（上游是普通 function 声明，调用走全局绑定，替换立即生效）。
   */
  function wrapFunction(name) {
    var original = root[name];
    if (typeof original !== 'function' || original.__mrParticleWrapped) return;
    var wrapped = function () {
      if (!enabled) return undefined;
      return original.apply(this, arguments);
    };
    wrapped.__mrParticleWrapped = true;
    root[name] = wrapped;
  }

  /** 把对象形式的模块（Sonic 地形/工坊）的 update 也包一层。 */
  function wrapApi(name) {
    var api = root[name];
    if (!api || typeof api.update !== 'function' || api.update.__mrParticleWrapped) return;
    var original = api.update;
    api.update = function () {
      if (!enabled) return undefined;
      return original.apply(this, arguments);
    };
    api.update.__mrParticleWrapped = true;
  }

  /** 已存在的粒子全部登记（兜底：万一有模块在包装前就建好了）。 */
  function sweepScene() {
    var scene = root.scene;
    if (!scene || typeof scene.traverse !== 'function') return;
    scene.traverse(function (obj) {
      if (obj && obj.isPoints) track(obj);
    });
  }

  /** 初始化：等上游模块全部注入后再包更新函数（index-loader 是同步注入的）。 */
  function init() {
    wrapFunction('updateSkullParticleLayer');
    wrapFunction('updateFloatLayer');
    wrapFunction('tickLyricsParticles');
    wrapApi('MineradioSonicTopography');
    wrapApi('MineradioSonicWorkshop');
    sweepScene();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
  // 上游的 Sonic 模块是单独的大脚本，可能晚一点才挂到 window 上，再补一次
  setTimeout(init, 2500);

  /**
   * 切换粒子效果。
   * @param {boolean} next
   */
  function setEnabled(next) {
    enabled = !!next;
    try {
      localStorage.setItem(STORAGE_KEY, enabled ? '1' : '0');
    } catch (e) { /* 存不下只影响下次启动 */ }
    registry.forEach(function (points) {
      applyDrawRange(points);
    });
    // 重新扫一遍：有些粒子是切预设时才创建的
    sweepScene();
    if (typeof root.showToast === 'function') {
      root.showToast(enabled ? '粒子效果已开启' : '粒子效果已关闭（省电）');
    }
  }

  root.MRParticles = {
    isEnabled: function () { return enabled; },
    setEnabled: setEnabled,
    /** 已登记的粒子对象数量，调试/自检用 */
    count: function () { return registry.length; },
  };
})(window);
