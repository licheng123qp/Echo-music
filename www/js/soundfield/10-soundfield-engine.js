// public/js/soundfield/10-soundfield-engine.js
// 领克 08 声场 DSP 引擎（Web Audio 实现）。
//
// 输入是播放器的主总线（原始立体声），输出接 ctx.destination。
// 为什么不在原生层做：(1) 页面音频由 WebView 内的 Chromium 混音，原生拿不到 PCM；
// (2) Web Audio 图在播放链路内，切换参数无需重启播放，也不会和节拍分析抢时钟。
//
// 信号链（从左到右）：
//   input → preGain → 左右分离 → 10 段 EQ（每声道独立）→ 平衡增益 → merger
//         → M/S 分解 → 宽度 / 虚拟中置 / 环绕 / 高度 四路渲染 → 限幅 → destination
//
// 设计约束：
//   · 所有参数改动都只改 AudioParam 或增益，不重建节点，避免爆音；
//   · 任何一路渲染失败都不能把主音频弄断——连接失败时自动回落到直通；
//   · 车机 CPU 有限，HRTF 是可选模式，默认等功率声像（equalpower）。

(function (root) {
  'use strict';

  var model = root.MRSoundFieldModel;
  if (!model) {
    // 模型没加载就什么都不做：宁可没有声场，也不能让播放器报错白屏
    console.warn('[SoundField] 车型模型未加载，声场功能停用');
    return;
  }

  var STORAGE_KEY = 'mineradio_soundfield_v1';

  /** 默认参数：开箱即用，且和「默认」预设一致（改这里记得同步 PRESETS[0]）。 */
  var DEFAULTS = {
    enabled: true,
    vehicleId: 'lynk-08',
    presetId: 'default',
    layout: '',            // 空 = 跟随车型默认布局
    width: 1.0,            // 声场宽度倍率 0~2
    center: 0.15,          // 虚拟中置 0~1
    surround: 0.30,        // 环绕感 0~1
    height: 0.15,          // 高度感 0~1
    balance: 0,            // 左右平衡 -100~100
    fader: 0,              // 前后平衡 -100(后)~100(前)
    eqEnabled: true,
    eq: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0], // 10 段增益（dB）
    mode: 'equalpower',    // equalpower | hrtf
  };

  /** 把数值夹到区间内；参数来自 UI 与 localStorage，必须防脏值。 */
  function clamp(value, min, max) {
    var n = Number(value);
    if (!isFinite(n)) return min;
    return Math.min(max, Math.max(min, n));
  }

  /** 深拷贝一份参数，避免调用方改到内部状态。 */
  function cloneParams(params) {
    return {
      enabled: !!params.enabled,
      vehicleId: params.vehicleId,
      presetId: params.presetId,
      layout: params.layout || '',
      width: Number(params.width) || 0,
      center: Number(params.center) || 0,
      surround: Number(params.surround) || 0,
      height: Number(params.height) || 0,
      balance: Number(params.balance) || 0,
      fader: Number(params.fader) || 0,
      eqEnabled: !!params.eqEnabled,
      eq: (params.eq || []).slice(0, 10).map(function (v) { return Number(v) || 0; }),
      mode: params.mode === 'hrtf' ? 'hrtf' : 'equalpower',
    };
  }

  /** 读取本地存档；损坏或版本不符时回落到默认值，不能让用户卡在启动失败。 */
  function loadParams() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return cloneParams(DEFAULTS);
      var parsed = JSON.parse(raw);
      return sanitizeParams(parsed);
    } catch (e) {
      return cloneParams(DEFAULTS);
    }
  }

  /** 校验并补全参数：缺字段用默认值补齐，数值越界夹回区间。 */
  function sanitizeParams(input) {
    var merged = Object.assign({}, DEFAULTS, input || {});
    var params = cloneParams(merged);
    params.width = clamp(params.width, 0, 2);
    params.center = clamp(params.center, 0, 1);
    params.surround = clamp(params.surround, 0, 1);
    params.height = clamp(params.height, 0, 1);
    params.balance = clamp(params.balance, -100, 100);
    params.fader = clamp(params.fader, -100, 100);
    if (params.eq.length < 10) {
      while (params.eq.length < 10) params.eq.push(0);
    }
    params.eq = params.eq.map(function (v) { return clamp(v, -12, 12); });
    // 车型/预设 id 必须真实存在，否则界面会出现「空选中项」
    if (!model.getVehicle(params.vehicleId) || model.getVehicle(params.vehicleId).id !== params.vehicleId) {
      params.vehicleId = DEFAULTS.vehicleId;
    }
    // 'custom' 是「用户手动拖过参数」的虚拟预设：不在预设表里，但必须允许保存，
    // 否则每次拖滑杆都会被夹回 'default'，界面高亮也会来回跳。
    if (params.presetId !== 'custom'
        && (!model.getPreset(params.presetId) || model.getPreset(params.presetId).id !== params.presetId)) {
      params.presetId = DEFAULTS.presetId;
    }
    return params;
  }

  /**
   * 声场引擎：一个 AudioContext 对应一个实例。
   * 播放器可能因为音频图恢复重建 AudioContext，所以引擎按 ctx 复用/重建。
   * @param {AudioContext} ctx
   */
  function SoundFieldEngine(ctx) {
    this.ctx = ctx;
    this.params = null;
    this._listeners = [];
    // 上一次的「有效布局」，供 UI 展示与实际渲染共用，避免两处各算一遍
    this._layout = '';
    this._build();
  }

  /** 建图：只在这里创建节点，之后所有参数都走 _apply。 */
  SoundFieldEngine.prototype._build = function () {
    var ctx = this.ctx;
    var self = this;

    this.input = ctx.createGain();
    this.input.gain.value = 1;

    this.preGain = ctx.createGain();
    this.preGain.gain.value = 1;

    // ── 左右分离 + 每声道 10 段 EQ ───────────────────────────────
    this.splitter = ctx.createChannelSplitter(2);
    this.eqL = [];
    this.eqR = [];
    this._makeEqChain(this.eqL);
    this._makeEqChain(this.eqR);

    // 平衡（左右）增益：单独放在 EQ 之后，避免被 EQ 的 Q 值影响
    this.gainL = ctx.createGain();
    this.gainR = ctx.createGain();

    this.merger = ctx.createChannelMerger(2);
    this.input.connect(this.preGain);
    this.preGain.connect(this.splitter);
    this.splitter.connect(this.eqL[0], 0, 0);
    this.splitter.connect(this.eqR[0], 1, 0);
    this.eqL[this.eqL.length - 1].connect(this.gainL);
    this.eqR[this.eqR.length - 1].connect(this.gainR);
    this.gainL.connect(this.merger, 0, 0);
    this.gainR.connect(this.merger, 0, 1);

    // ── M/S 分解：mid=(L+R)/2，side=(L-R)/2 ─────────────────────
    this.wSplit = ctx.createChannelSplitter(2);
    this.midSum = ctx.createGain();
    this.sideSum = ctx.createGain();
    this.merger.connect(this.wSplit);

    // 每路先乘 0.5，保证重建后幅度与原始一致（否则宽度一变整体就 +6dB）
    var midL = ctx.createGain(); midL.gain.value = 0.5;
    var midR = ctx.createGain(); midR.gain.value = 0.5;
    var sideL = ctx.createGain(); sideL.gain.value = 0.5;
    var sideR = ctx.createGain(); sideR.gain.value = -0.5;
    this.wSplit.connect(midL, 0, 0);
    this.wSplit.connect(midR, 1, 0);
    this.wSplit.connect(sideL, 0, 0);
    this.wSplit.connect(sideR, 1, 0);
    midL.connect(this.midSum);
    midR.connect(this.midSum);
    sideL.connect(this.sideSum);
    sideR.connect(this.sideSum);

    // ── 宽度：L = M + w·S，R = M − w·S ──────────────────────────
    this.outMerge = ctx.createChannelMerger(2);
    this.widthL = ctx.createGain();
    this.widthR = ctx.createGain();
    this.widthL.gain.value = 1;
    this.widthR.gain.value = -1;
    this.midSum.connect(this.outMerge, 0, 0);
    this.midSum.connect(this.outMerge, 0, 1);
    this.sideSum.connect(this.widthL);
    this.sideSum.connect(this.widthR);
    this.widthL.connect(this.outMerge, 0, 0);
    this.widthR.connect(this.outMerge, 0, 1);

    this.postGain = ctx.createGain();
    this.outMerge.connect(this.postGain);

    // ── 虚拟中置：把 mid 抽一部分送到正前方，模拟 7.1.4 的 FC ──
    this.centerGain = ctx.createGain();
    this.centerPan = ctx.createPanner();
    this._initPanner(this.centerPan, 0, -0.05, -1.15);
    this.midSum.connect(this.centerGain);
    this.centerGain.connect(this.centerPan);

    // ── 环绕：把 side 延迟后送到左右后方，制造包围感 ────────────
    this.ambientGain = ctx.createGain();
    this.ambientDelay = ctx.createDelay(0.1);
    this.ambientDelay.delayTime.value = 0.018;
    this.ambientLP = ctx.createBiquadFilter();
    this.ambientLP.type = 'lowpass';
    this.ambientLP.frequency.value = 7000;
    this.ambientPanL = ctx.createPanner();
    this.ambientPanR = ctx.createPanner();
    this._initPanner(this.ambientPanL, -0.82, 0.02, 0.55);
    this._initPanner(this.ambientPanR, 0.82, 0.02, 0.55);
    this.ambientSendL = ctx.createGain();
    this.ambientSendR = ctx.createGain();
    this.sideSum.connect(this.ambientGain);
    this.ambientGain.connect(this.ambientDelay);
    this.ambientDelay.connect(this.ambientLP);
    this.ambientLP.connect(this.ambientSendL);
    this.ambientLP.connect(this.ambientSendR);
    this.ambientSendL.connect(this.ambientPanL);
    this.ambientSendR.connect(this.ambientPanR);

    // ── 高度：mid 的高频段延迟少量后抬到头顶 ───────────────────
    this.heightGain = ctx.createGain();
    this.heightHP = ctx.createBiquadFilter();
    this.heightHP.type = 'highpass';
    this.heightHP.frequency.value = 2200;
    this.heightDelay = ctx.createDelay(0.05);
    this.heightDelay.delayTime.value = 0.006;
    this.heightPanL = ctx.createPanner();
    this.heightPanR = ctx.createPanner();
    this._initPanner(this.heightPanL, -0.55, 0.62, -0.45);
    this._initPanner(this.heightPanR, 0.55, 0.62, -0.45);
    this.heightSendL = ctx.createGain();
    this.heightSendR = ctx.createGain();
    this.midSum.connect(this.heightGain);
    this.heightGain.connect(this.heightHP);
    this.heightHP.connect(this.heightDelay);
    this.heightDelay.connect(this.heightSendL);
    this.heightDelay.connect(this.heightSendR);
    this.heightSendL.connect(this.heightPanL);
    this.heightSendR.connect(this.heightPanR);

    // ── 汇总 → 限幅 → 输出 ─────────────────────────────────────
    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -2;
    this.limiter.knee.value = 0;
    this.limiter.ratio.value = 20;
    this.limiter.attack.value = 0.003;
    this.limiter.release.value = 0.25;

    this.postGain.connect(this.limiter);
    this.centerPan.connect(this.limiter);
    this.ambientPanL.connect(this.limiter);
    this.ambientPanR.connect(this.limiter);
    this.heightPanL.connect(this.limiter);
    this.heightPanR.connect(this.limiter);
    this.limiter.connect(ctx.destination);

    // 初始状态：先按「未启用」连好直通，等 setParams 再决定走向
    this.enabled = false;
    this.input.disconnect();
    this.input.connect(ctx.destination);
  };

  /** 生成一条 10 段 EQ 链（首尾分别是低架/高架，中间是峰值滤波）。 */
  SoundFieldEngine.prototype._makeEqChain = function (store) {
    var freqs = model.EQ_FREQUENCIES;
    var prev = null;
    for (var i = 0; i < freqs.length; i++) {
      var filter = this.ctx.createBiquadFilter();
      if (i === 0) {
        filter.type = 'lowshelf';
      } else if (i === freqs.length - 1) {
        filter.type = 'highshelf';
      } else {
        filter.type = 'peaking';
        filter.Q.value = 1.1;
      }
      filter.frequency.value = freqs[i];
      filter.gain.value = 0;
      if (prev) prev.connect(filter);
      prev = filter;
      store.push(filter);
    }
  };

  /** 初始化一个声像节点：等功率是默认，HRTF 作为「沉浸」可选模式。 */
  SoundFieldEngine.prototype._initPanner = function (panner, x, y, z) {
    panner.panningModel = this.params && this.params.mode === 'hrtf' ? 'HRTF' : 'equalpower';
    panner.distanceModel = 'inverse';
    panner.refDistance = 1;
    panner.maxDistance = 12;
    panner.rolloffFactor = 0.25;
    if (panner.positionX) {
      panner.positionX.value = x;
      panner.positionY.value = y;
      panner.positionZ.value = z;
    } else if (panner.setPosition) {
      panner.setPosition(x, y, z);
    }
  };

  /**
   * 应用一份参数快照。
   * 所有节点都用 setTargetAtTime 平滑过渡，避免拖动滑杆时出现「咔哒」声。
   */
  SoundFieldEngine.prototype.apply = function (rawParams) {
    var params = sanitizeParams(rawParams);
    this.params = params;
    var ctx = this.ctx;
    var now = ctx.currentTime;

    // 平滑到目标值：时间常数 0.02s 听感接近「瞬时」，又不会产生阶跃爆音
    var smooth = function (param, value) {
      if (!param) return;
      try {
        param.setTargetAtTime(value, now, 0.02);
      } catch (e) {
        param.value = value;
      }
    };

    // 1) 开关：关闭时 input 直连 destination，整条链不再吃输入
    if (params.enabled !== this.enabled) {
      this.enabled = params.enabled;
      try { this.input.disconnect(); } catch (e) { }
      if (this.enabled) {
        this.input.connect(this.preGain);
      } else {
        this.input.connect(ctx.destination);
      }
    }

    // 2) 声像模式：切换 HRTF 会重新计算脉冲响应，属于开销最大的一次参数变更
    var panMode = params.mode === 'hrtf' ? 'HRTF' : 'equalpower';
    [this.centerPan, this.ambientPanL, this.ambientPanR, this.heightPanL, this.heightPanR].forEach(function (p) {
      if (p && p.panningModel !== panMode) p.panningModel = panMode;
    });

    // 3) 布局：显式指定 > 预设指定 > 车型默认；决定环绕/顶置两路是否出声
    var vehicle = model.getVehicle(params.vehicleId);
    var preset = model.getPreset(params.presetId);
    var layout = params.layout || preset.layout || vehicle.defaultLayout;
    if (vehicle.layouts.indexOf(layout) === -1) layout = vehicle.defaultLayout;
    if (params.presetId === 'auto-immersive') {
      layout = model.resolveAutoLayout(vehicle, vehicle.layouts);
    }
    this._layout = layout;
    var channels = model.LAYOUTS[layout] || model.LAYOUTS['2.0'];
    var hasSurround = channels.indexOf('SL') !== -1 || channels.indexOf('BL') !== -1;
    var hasHeight = channels.indexOf('TFL') !== -1 || channels.indexOf('TBL') !== -1;

    // 4) EQ：关闭时把增益全部归零，但保留节点（避免重建链路）
    for (var i = 0; i < 10; i++) {
      var gainDb = params.eqEnabled ? params.eq[i] : 0;
      if (this.eqL[i]) this.eqL[i].gain.value = gainDb;
      if (this.eqR[i]) this.eqR[i].gain.value = gainDb;
    }

    // 5) 左右平衡：等功率压一侧，-100 只剩左声道，+100 只剩右声道
    var balance = params.balance / 100;
    var leftGain = balance <= 0 ? 1 : Math.cos(balance * Math.PI / 2);
    var rightGain = balance >= 0 ? 1 : Math.cos(-balance * Math.PI / 2);
    smooth(this.gainL.gain, leftGain);
    smooth(this.gainR.gain, rightGain);

    // 6) 声场宽度：side 增益就是宽度倍率；宽度 0 时退化成单声道
    smooth(this.widthL.gain, params.width);
    smooth(this.widthR.gain, -params.width);

    // 7) 虚拟中置：mid 抽头送正前方；同时压低直达声做补偿
    var center = params.center;
    smooth(this.centerGain.gain, center * 0.75);

    // 8) 环绕：fader 越靠后，环绕占比越高；车型舱宽决定延迟量
    var fader = params.fader / 100;
    var rearBias = 0.5 - fader * 0.5; // fader=+1（最前）→0，fader=-1（最后）→1
    var surroundLevel = hasSurround ? params.surround * (0.55 + rearBias * 0.75) : 0;
    smooth(this.ambientSendL.gain, surroundLevel * 0.5);
    smooth(this.ambientSendR.gain, surroundLevel * 0.5);
    var delaySeconds = 0.012 + 0.012 * (vehicle.cabinWidth / 1.5);
    smooth(this.ambientDelay.delayTime, delaySeconds);

    // 9) 高度：只有含顶置声道的布局才出声；fader 靠前时略增，靠后时略减
    var heightLevel = hasHeight ? params.height * (0.6 + (1 - rearBias) * 0.4) : 0;
    smooth(this.heightGain.gain, heightLevel * 0.55);

    // 10) 总补偿：四路叠加会抬高响度，用反比增益压回去，交给限幅器兜底
    var energy = 1 + (params.width - 1) * 0.30 + center * 0.22 + surroundLevel * 0.25 + heightLevel * 0.18;
    var makeup = clamp(1 / Math.max(1, energy), 0.45, 1);
    smooth(this.postGain.gain, makeup);

    // 11) 前场直达声随 fader 变化：声场越靠前，前场越亮
    smooth(this.preGain.gain, 0.92 + 0.08 * (fader + 1) / 2);

    this._emit();
  };

  /** 当前有效布局（UI 用来显示「7.1.4 / 23 扬声器」）。 */
  SoundFieldEngine.prototype.getLayout = function () {
    return this._layout;
  };

  /** 订阅参数变化（面板刷新用）；返回取消订阅函数。 */
  SoundFieldEngine.prototype.onChange = function (listener) {
    this._listeners.push(listener);
    var self = this;
    return function () {
      var index = self._listeners.indexOf(listener);
      if (index >= 0) self._listeners.splice(index, 1);
    };
  };

  /** 通知所有订阅者：参数已生效。 */
  SoundFieldEngine.prototype._emit = function () {
    var snapshot = this.params;
    this._listeners.slice().forEach(function (fn) {
      try { fn(snapshot); } catch (e) { console.warn('[SoundField] listener error', e); }
    });
  };

  // ─────────────────────────────────────────────────────────────
  // 模块级 API：播放器只认识 outputNode(ctx)，其余给 UI 用
  // ─────────────────────────────────────────────────────────────

  var currentEngine = null;
  var currentParams = loadParams();

  /** 是否已经挂到某次播放的音频图上（未播放时为 false，UI 据此提示）。 */
  function isAttached() {
    return !!(currentEngine && currentEngine.ctx && currentEngine.ctx.state !== 'closed');
  }

  /**
   * 取/建声场输入节点。
   * 播放器每次初始化音频图都会调用它；ctx 变了就重建引擎并套用已保存参数。
   * @param {AudioContext} ctx
   * @returns {AudioNode} 把主总线接到这个节点即可
   */
  function outputNode(ctx) {
    if (!ctx) return null;
    if (!currentEngine || currentEngine.ctx !== ctx || currentEngine.ctx.state === 'closed') {
      try {
        currentEngine = new SoundFieldEngine(ctx);
        currentEngine.apply(currentParams);
      } catch (e) {
        // 建图失败（极老 WebView 缺节点类型）：退回直通，绝不让播放失败
        console.warn('[SoundField] 引擎创建失败，已回退直通', e);
        currentEngine = null;
        return ctx.destination;
      }
    }
    return currentEngine ? currentEngine.input : ctx.destination;
  }

  /** 读取当前参数（副本）。 */
  function getParams() {
    return cloneParams(currentParams);
  }

  /** 合并更新参数并立即生效 + 落盘。 */
  function patch(partial) {
    var next = Object.assign({}, partial || {});
    // 只调音色/声场参数而没点名预设时，自动标记为「自定义」：
    // 否则界面会继续高亮「驾驶位优先」，但实际参数已经不是那一套了，属于误导。
    var TUNING_KEYS = ['width', 'center', 'surround', 'height', 'balance', 'fader', 'eq', 'eqEnabled'];
    if (!('presetId' in next) && TUNING_KEYS.some(function (key) { return key in next; })) {
      next.presetId = 'custom';
    }
    currentParams = sanitizeParams(Object.assign({}, currentParams, next));
    save();
    if (currentEngine) currentEngine.apply(currentParams);
    else notify();
    return getParams();
  }

  /** 整体替换参数（导入存档/切换预设时用）。 */
  function setParams(next) {
    currentParams = sanitizeParams(next || {});
    save();
    if (currentEngine) currentEngine.apply(currentParams);
    else notify();
    return getParams();
  }

  /** 写入 localStorage；隐私模式/配额满时静默失败，不影响本次播放。 */
  function save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(currentParams));
    } catch (e) { /* 存不下就算了 */ }
  }

  /** 恢复默认参数（保留当前车型选择，避免用户被「重置」踢回领克08）。 */
  function reset() {
    var vehicleId = currentParams.vehicleId;
    currentParams = sanitizeParams(Object.assign({}, DEFAULTS, { vehicleId: vehicleId }));
    save();
    if (currentEngine) currentEngine.apply(currentParams);
    else notify();
    return getParams();
  }

  /**
   * 切换预设：把预设里的渲染参数写进当前参数，同时保留车型与开关。
   * 这样用户在「驾驶位优先 / 全车均衡」之间切换时，不会丢掉自己的车型设置。
   */
  function applyPreset(presetId) {
    var preset = model.getPreset(presetId);
    var next = Object.assign({}, currentParams, {
      presetId: preset.id,
      layout: preset.layout || '',
      width: preset.params.width,
      center: preset.params.center,
      surround: preset.params.surround,
      height: preset.params.height,
      fader: preset.params.fader,
      eq: preset.params.eq.slice(),
    });
    return setParams(next);
  }

  /** 参数变化通知：引擎未挂载时 UI 也要能刷新，所以这里单独发一次。 */
  function notify() {
    var snapshot = cloneParams(currentParams);
    panelListeners.slice().forEach(function (fn) {
      try { fn(snapshot); } catch (e) { }
    });
  }

  var panelListeners = [];

  /** 订阅参数变化（无论引擎是否已挂载）。 */
  function onChange(fn) {
    panelListeners.push(fn);
    if (currentEngine) currentEngine.onChange(fn);
    return function () {
      var i = panelListeners.indexOf(fn);
      if (i >= 0) panelListeners.splice(i, 1);
    };
  }

  root.MRSoundField = {
    outputNode: outputNode,
    getParams: getParams,
    setParams: setParams,
    patch: patch,
    applyPreset: applyPreset,
    reset: reset,
    onChange: onChange,
    isAttached: isAttached,
    getLayout: function () { return currentEngine ? currentEngine.getLayout() : ''; },
    /** 调试入口：控制台里可直接看当前引擎与参数 */
    _debug: function () { return { engine: currentEngine, params: currentParams }; },
  };
})(window);
