// public/js/soundfield/00-vehicle-model.js
// 声场（SoundField）车型与场景模型 —— 移植自 FXPlayer（声场 SoundField）工程的
// audio-model 模块，去掉 Kotlin 类型、只保留本应用真正用到的数据与派生规则。
//
// 为什么单独一个文件：
//   车型档案（扬声器数量、可用布局、默认布局）与声场预设（GainProfile）是产品规则，
//   不是 DSP 细节；DSP 怎么实现可以换，但车型口径必须和车机侧保持一致，
//   否则「同一个预设」在两端的听感会漂。
//
// 与原工程的差异（刻意为之）：
//   原工程输出的是多声道 AudioTrack（7.1.4 等），本应用跑在 WebView 里，
//   最终出口只有立体声，所以这里的布局是「虚拟布局」——用于决定 23 个扬声器的
//   声像位置与增益分配，再由 DSP 渲染成立体声。布局名保留车机口径，便于对照。

(function (root) {
  'use strict';

  /**
   * 声道布局定义。
   * 键是布局 id（与 FXPlayer ChannelLayout 一致），值是逻辑声道列表；
   * 逻辑声道再由 SPEAKER_GEOMETRY 映射到三维坐标，供 HRTF/等功率声像使用。
   */
  var LAYOUTS = {
    '2.0': ['FL', 'FR'],
    '4.0': ['FL', 'FR', 'BL', 'BR'],
    '5.1': ['FL', 'FR', 'FC', 'LFE', 'BL', 'BR'],
    '5.1.2': ['FL', 'FR', 'FC', 'LFE', 'BL', 'BR', 'TFL', 'TFR'],
    '5.1.4': ['FL', 'FR', 'FC', 'LFE', 'BL', 'BR', 'TFL', 'TFR', 'TBL', 'TBR'],
    '6.1': ['FL', 'FR', 'FC', 'LFE', 'BC', 'SL', 'SR'],
    '7.1': ['FL', 'FR', 'FC', 'LFE', 'BL', 'BR', 'SL', 'SR'],
    '7.1.2': ['FL', 'FR', 'FC', 'LFE', 'BL', 'BR', 'SL', 'SR', 'TFL', 'TFR'],
    '7.1.4': ['FL', 'FR', 'FC', 'LFE', 'BL', 'BR', 'SL', 'SR', 'TFL', 'TFR', 'TBL', 'TBR'],
    '9.1.4': ['FL', 'FR', 'FC', 'LFE', 'BL', 'BR', 'SL', 'SR', 'FWL', 'FWR', 'TFL', 'TFR', 'TBL', 'TBR'],
  };

  /**
   * 逻辑声道的空间坐标（单位为米，车舱坐标：x 右正，y 上正，z 车头方向为 -1）。
   * 座位参考点取驾驶位耳朵附近，领克 08 车舱半宽约 0.75m。
   * 这些数值只影响声像角度与距离衰减，不影响频率响应，所以允许比原工程粗略。
   */
  var SPEAKER_GEOMETRY = {
    FL: { x: -0.72, y: 0.02, z: -0.55 },
    FR: { x: 0.72, y: 0.02, z: -0.55 },
    FC: { x: 0.0, y: -0.05, z: -1.15 },
    LFE: { x: 0.0, y: -0.55, z: -0.2 },
    BL: { x: -0.72, y: 0.02, z: 0.85 },
    BR: { x: 0.72, y: 0.02, z: 0.85 },
    BC: { x: 0.0, y: 0.02, z: 1.05 },
    SL: { x: -0.82, y: 0.02, z: 0.15 },
    SR: { x: 0.82, y: 0.02, z: 0.15 },
    TFL: { x: -0.55, y: 0.62, z: -0.45 },
    TFR: { x: 0.55, y: 0.62, z: -0.45 },
    TBL: { x: -0.55, y: 0.62, z: 0.65 },
    TBR: { x: 0.55, y: 0.62, z: 0.65 },
    FWL: { x: -1.0, y: 0.05, z: -0.85 },
    FWR: { x: 1.0, y: 0.05, z: -0.85 },
  };

  /** 只有顶置声道的布局集合（领克 08 全系都在这一档）。 */
  var HEIGHT_LAYOUTS = ['2.0', '4.0', '5.1', '6.1', '7.1', '5.1.2', '5.1.4', '7.1.2', '7.1.4'];

  /** 无顶置声道的基础布局。 */
  var CORE_LAYOUTS = ['2.0', '4.0', '5.1', '6.1', '7.1'];

  /**
   * 车型目录（节选：本应用面向领克/银河车系，未列出的车型走 other）。
   * 字段含义：
   *   id            车型 id，持久化用，不要改（改了用户存档就丢）
   *   displayName   界面展示名
   *   layouts       该车型允许的布局白名单
   *   defaultLayout 默认布局（用户没选过时用）
   *   speakerCount  物理扬声器数量，用于界面展示与增益分摊
   *   cabinWidth    车舱宽度（米），影响声场宽度与延迟标定
   *   preferMax     自动模式下是否优先取最大布局（领克 08 是唯一为 true 的车型）
   *   notes         界面上的提示文案
   */
  var VEHICLES = [
    {
      id: 'lynk-08',
      displayName: '领克 08（23 / 25 款）',
      layouts: HEIGHT_LAYOUTS,
      defaultLayout: '7.1.4',
      speakerCount: 23,
      cabinWidth: 1.5,
      preferMax: true,
      notes: '哈曼卡顿 23 扬声器，含 4 个顶置声道；唯一「自动全景声」直接取最大布局的车型。',
    },
    {
      id: 'lynk-08-2026',
      displayName: '领克 08（26 款）',
      layouts: HEIGHT_LAYOUTS,
      defaultLayout: '7.1.4',
      speakerCount: 23,
      cabinWidth: 1.5,
      preferMax: true,
      notes: '26 款沿用 23 扬声器布局，车机指纹变了，声场参数与 23/25 款保持一致。',
    },
    {
      id: 'lynk-07',
      displayName: '领克 07（24 款）',
      layouts: HEIGHT_LAYOUTS,
      defaultLayout: '7.1.4',
      speakerCount: 23,
      cabinWidth: 1.48,
      preferMax: false,
    },
    {
      id: 'lynk-07-2026',
      displayName: '领克 07（26 款）',
      layouts: HEIGHT_LAYOUTS,
      defaultLayout: '7.1.4',
      speakerCount: 23,
      cabinWidth: 1.48,
      preferMax: false,
    },
    {
      id: 'lynk-z20',
      displayName: '领克 Z20',
      layouts: HEIGHT_LAYOUTS,
      defaultLayout: '7.1.4',
      speakerCount: 14,
      cabinWidth: 1.42,
      preferMax: false,
    },
    {
      id: 'lynk-10-em-p',
      displayName: '领克 10 EM-P',
      layouts: HEIGHT_LAYOUTS,
      defaultLayout: '7.1.4',
      speakerCount: 23,
      cabinWidth: 1.56,
      preferMax: false,
    },
    {
      id: 'lynk-900',
      displayName: '领克 900',
      layouts: ['2.0', '4.0', '5.1', '6.1', '7.1', '5.1.2', '5.1.4', '7.1.2', '7.1.4', '9.1.4'],
      defaultLayout: '9.1.4',
      speakerCount: 31,
      cabinWidth: 1.62,
      preferMax: true,
      notes: '唯一允许 9.1.4 的车型，实际能否放出取决于车机 HAL 是否接受宽声道掩码。',
    },
    {
      id: 'geely-8',
      displayName: '星耀 8',
      layouts: ['2.0'],
      defaultLayout: '2.0',
      speakerCount: 6,
      cabinWidth: 1.45,
      preferMax: false,
      notes: '立体声兼容音效：车机 HAL 会报多声道能力但实际放不出来，强制 2.0。',
    },
    {
      id: 'geely-galaxy-e5',
      displayName: '银河 E5（23 扬声器）',
      layouts: HEIGHT_LAYOUTS,
      defaultLayout: '7.1.4',
      speakerCount: 23,
      cabinWidth: 1.46,
      preferMax: false,
    },
    {
      id: 'other',
      displayName: '其他车型（通用）',
      layouts: CORE_LAYOUTS,
      defaultLayout: '7.1',
      speakerCount: 8,
      cabinWidth: 1.5,
      preferMax: false,
      notes: '未识别车型的兜底：不做顶置声道渲染，只做基础声场。',
    },
  ];

  /**
   * 声场预设。
   * 与 FXPlayer ScenePreset 的 id/display 对齐；explicitLayout 为空表示「跟随车型默认布局」。
   * params 是本应用新增的立体声渲染参数（原工程输出多声道，不需要这些）。
   *   width    声场宽度倍率（1 = 原始立体声）
   *   center   虚拟中置强度 0~1
   *   surround 环绕/混响感 0~1
   *   height   高度感 0~1
   *   fader    前后平衡 -100(后) ~ +100(前)
   *   eq       默认 EQ 曲线（dB，10 段）
   */
  var PRESETS = [
    {
      id: 'default',
      display: '默认',
      kind: 'contextual',
      gainProfile: 'flat',
      params: { width: 1.0, center: 0.15, surround: 0.30, height: 0.15, fader: 0, eq: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
    },
    {
      id: 'auto-immersive',
      display: '自动全景声',
      kind: 'auto',
      gainProfile: 'flat',
      params: { width: 1.45, center: 0.18, surround: 0.55, height: 0.40, fader: -5, eq: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
    },
    {
      id: 'driver-first',
      display: '驾驶位优先',
      kind: 'strategy',
      gainProfile: 'driver',
      params: { width: 0.92, center: 0.55, surround: 0.16, height: 0.10, fader: 20, eq: [0, 0, 1, 2, 3, 3, 2, 1, 0, 0] },
    },
    {
      id: 'cabin-balanced',
      display: '全车均衡',
      kind: 'strategy',
      gainProfile: 'balanced',
      params: { width: 1.25, center: 0.20, surround: 0.45, height: 0.28, fader: 0, eq: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
    },
    {
      id: 'surround-7.1.4',
      display: '7.1.4 环绕',
      kind: 'explicit',
      layout: '7.1.4',
      gainProfile: 'surround',
      params: { width: 1.55, center: 0.12, surround: 0.70, height: 0.50, fader: -10, eq: [1, 1, 0, 0, 0, 0, 1, 2, 2, 1] },
    },
    {
      id: 'stereo',
      display: '2.0 纯直通',
      kind: 'explicit',
      layout: '2.0',
      gainProfile: 'flat',
      params: { width: 1.0, center: 0, surround: 0, height: 0, fader: 0, eq: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
    },
  ];

  /** 10 段 EQ 的中心频率（Hz），与界面从上到下/左到右的顺序一致。 */
  var EQ_FREQUENCIES = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];

  /** EQ 预设曲线：键给界面用，值直接写进 10 段增益。 */
  var EQ_PRESETS = {
    flat: { display: '平直', gains: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
    pop: { display: '流行', gains: [-1, 0, 1, 3, 3, 2, 0, -1, 0, 1] },
    classical: { display: '古典', gains: [2, 2, 1, 0, 0, 0, 1, 2, 3, 3] },
    vocal: { display: '人声', gains: [-2, -1, 0, 2, 4, 4, 2, 0, -1, -2] },
    bass: { display: '低音', gains: [6, 5, 3, 1, 0, -1, -1, 0, 0, 0] },
    treble: { display: '高音', gains: [-2, -2, -1, 0, 0, 1, 2, 3, 4, 5] },
  };

  /** 按 id 取车型；找不到回退到 other，保证界面永远有可用档案。 */
  function getVehicle(id) {
    for (var i = 0; i < VEHICLES.length; i++) {
      if (VEHICLES[i].id === id) return VEHICLES[i];
    }
    return VEHICLES[VEHICLES.length - 1];
  }

  /** 按 id 取预设；找不到回退到默认预设。 */
  function getPreset(id) {
    for (var i = 0; i < PRESETS.length; i++) {
      if (PRESETS[i].id === id) return PRESETS[i];
    }
    return PRESETS[0];
  }

  /**
   * 自动全景声的布局选择。
   * 规则来自 FXPlayer LayoutResolver：先取车型白名单里可用的最大布局；
   * 领克 08 的 preferMax 就是为这条规则存在的（其余车型走「最少够用」）。
   */
  function resolveAutoLayout(vehicle, availableLayouts) {
    var allowed = (availableLayouts && availableLayouts.length ? availableLayouts : vehicle.layouts);
    var best = vehicle.defaultLayout;
    var bestScore = -1;
    for (var i = 0; i < allowed.length; i++) {
      var id = allowed[i];
      if (vehicle.layouts.indexOf(id) === -1) continue;
      var score = LAYOUTS[id] ? LAYOUTS[id].length : 0;
      if (score > bestScore) {
        bestScore = score;
        best = id;
      }
    }
    return best;
  }

  /** 逻辑声道 → 三维坐标；未知声道回退到正前方，宁可保守不要抛错。 */
  function speakerPosition(channel) {
    return SPEAKER_GEOMETRY[channel] || { x: 0, y: 0, z: -1 };
  }

  // 挂到全局：其余两个模块（DSP / UI）都从这里取数据，避免各自复制一份口径
  root.MRSoundFieldModel = {
    LAYOUTS: LAYOUTS,
    HEIGHT_LAYOUTS: HEIGHT_LAYOUTS,
    CORE_LAYOUTS: CORE_LAYOUTS,
    VEHICLES: VEHICLES,
    PRESETS: PRESETS,
    EQ_FREQUENCIES: EQ_FREQUENCIES,
    EQ_PRESETS: EQ_PRESETS,
    getVehicle: getVehicle,
    getPreset: getPreset,
    resolveAutoLayout: resolveAutoLayout,
    speakerPosition: speakerPosition,
  };
})(window);
