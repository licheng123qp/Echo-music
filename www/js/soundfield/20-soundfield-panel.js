// public/js/soundfield/20-soundfield-panel.js
// 领克 08 声场控制面板（纯 DOM 自建，不改动 Mineradio 原有的 fx 面板）。
//
// 为什么自建而不是塞进现有设置面板：
//   现有 fx 面板是桌面版遗留的密集网格，车机上手指点不准；声场是「一上车就要调」的
//   高频功能，需要独立入口 + 大控件。自建面板也避免和上游 fx 面板的改版互相踩。
//
// 交互约定：
//   · 所有滑杆 input 事件即时生效（只改 AudioParam，不重建链路，不会卡顿）；
//   · 每次改动写 localStorage，下次启动自动恢复；
//   · 点击遮罩/关闭按钮退出，不劫持播放器的手势与快捷键。

(function (root) {
  'use strict';

  var model = root.MRSoundFieldModel;
  var engine = root.MRSoundField;
  if (!model || !engine) {
    console.warn('[SoundField] 依赖未就绪，面板不加载');
    return;
  }

  /** 面板 DOM 引用缓存：只创建一次，反复开关不重建。 */
  var dom = {};
  var built = false;

  /** 滑杆定义：id、标题、取值范围、单位、是否显示两端提示。 */
  var SLIDERS = [
    { key: 'width', label: '声场宽度', min: 0, max: 2, step: 0.01, format: function (v) { return Math.round(v * 100) + '%'; }, left: '单声道', right: '超宽' },
    { key: 'center', label: '虚拟中置', min: 0, max: 1, step: 0.01, format: function (v) { return Math.round(v * 100) + '%'; }, left: '关', right: '强' },
    { key: 'surround', label: '环绕强度', min: 0, max: 1, step: 0.01, format: function (v) { return Math.round(v * 100) + '%'; }, left: '关', right: '强' },
    { key: 'height', label: '高度感', min: 0, max: 1, step: 0.01, format: function (v) { return Math.round(v * 100) + '%'; }, left: '关', right: '强' },
    { key: 'balance', label: '左右平衡', min: -100, max: 100, step: 1, format: function (v) { return v === 0 ? '居中' : (v < 0 ? '左 ' + Math.abs(v) : '右 ' + v); }, left: '左', right: '右' },
    { key: 'fader', label: '前后声场', min: -100, max: 100, step: 1, format: function (v) { return v === 0 ? '居中' : (v < 0 ? '后 ' + Math.abs(v) : '前 ' + v); }, left: '后排', right: '前排' },
  ];

  /** 小工具：创建元素并一次性设置属性/文本。 */
  function el(tag, attrs, text) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (key) {
        if (key === 'className') node.className = attrs[key];
        else if (key === 'style') node.setAttribute('style', attrs[key]);
        else node.setAttribute(key, attrs[key]);
      });
    }
    if (text != null) node.textContent = text;
    return node;
  }

  /** 构建整个面板：只在第一次打开时调用。 */
  function build() {
    if (built) return;
    built = true;

    var rootNode = el('div', { className: 'sf-root', id: 'sf-root' });

    // 悬浮入口：右下角常驻，车机上拇指可及；面板打开时隐藏，避免遮挡
    dom.launcher = el('button', { className: 'sf-launcher', id: 'sf-launcher', type: 'button', 'aria-label': '打开声场控制' });
    dom.launcher.innerHTML = '<svg viewBox="0 0 24 24" width="46%" height="46%" aria-hidden="true"><path d="M4 13l1.6-4.2A3 3 0 018.4 7h7.2a3 3 0 012.8 1.8L20 13v5h-2.5v-1.5h-11V18H4v-5z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><circle cx="8" cy="14.2" r="1.2" fill="currentColor"/><circle cx="16" cy="14.2" r="1.2" fill="currentColor"/></svg><span>声场</span>';

    dom.backdrop = el('div', { className: 'sf-backdrop', id: 'sf-backdrop' });

    dom.panel = el('section', { className: 'sf-panel', id: 'sf-panel', role: 'dialog', 'aria-label': '领克08声场控制' });

    // ── 头部 ────────────────────────────────────────────────
    var head = el('header', { className: 'sf-head' });
    var titleBox = el('div', { className: 'sf-title-box' });
    titleBox.appendChild(el('div', { className: 'sf-title' }, '领克 08 声场'));
    dom.subtitle = el('div', { className: 'sf-subtitle' }, '7.1.4 · 23 扬声器');
    titleBox.appendChild(dom.subtitle);
    head.appendChild(titleBox);

    var headActions = el('div', { className: 'sf-head-actions' });
    dom.enableBtn = el('button', { className: 'sf-power', type: 'button', 'aria-pressed': 'true' }, '已开启');
    dom.closeBtn = el('button', { className: 'sf-close', type: 'button', 'aria-label': '关闭' }, '×');
    headActions.appendChild(dom.enableBtn);
    headActions.appendChild(dom.closeBtn);
    head.appendChild(headActions);
    dom.panel.appendChild(head);

    var body = el('div', { className: 'sf-body' });
    dom.body = body;

    // ── 车型选择 ────────────────────────────────────────────
    body.appendChild(el('div', { className: 'sf-section-label' }, '车型'));
    dom.vehicleSelect = el('select', { className: 'sf-select', id: 'sf-vehicle' });
    model.VEHICLES.forEach(function (vehicle) {
      var option = el('option', { value: vehicle.id }, vehicle.displayName);
      dom.vehicleSelect.appendChild(option);
    });
    body.appendChild(dom.vehicleSelect);
    dom.vehicleNote = el('div', { className: 'sf-note' }, '');
    body.appendChild(dom.vehicleNote);

    // ── 界面与性能 ──────────────────────────────────────────
    // 车机上「界面大小 / 画质 / 帧率」是最先要调的三项，藏在上游 fx 面板里要点三层，
    // 实际不会有人去调，所以合并到声场面板里。
    body.appendChild(el('div', { className: 'sf-section-label' }, '界面与性能'));

    /** 生成一行「标题 + 单选 chip 组」，返回 chip 容器。 */
    function addChipRow(title, items, attr) {
      var wrap = el('div', { className: 'sf-inline-row' });
      wrap.appendChild(el('span', { className: 'sf-inline-label' }, title));
      var row = el('div', { className: 'sf-chips sf-chips-sm sf-inline-chips' });
      items.forEach(function (item) {
        var attrs = { className: 'sf-chip', type: 'button' };
        attrs[attr] = item.value;
        row.appendChild(el('button', attrs, item.label));
      });
      wrap.appendChild(row);
      body.appendChild(wrap);
      return row;
    }

    dom.zoomRow = addChipRow('界面缩放', [
      { value: '1', label: '100%' },
      { value: '1.15', label: '115%' },
      { value: '1.3', label: '130%' },
    ], 'data-zoom');

    dom.qualityRow = addChipRow('画质', [
      { value: 'eco', label: '低' },
      { value: 'balanced', label: '中' },
      { value: 'high', label: '高' },
    ], 'data-quality');

    dom.particlesRow = addChipRow('粒子效果', [
      { value: 'off', label: '关（省电）' },
      { value: 'on', label: '开' },
    ], 'data-particles');

    dom.fpsRow = addChipRow('帧率上限', [
      { value: '30', label: '30' },
      { value: '45', label: '45' },
      { value: '60', label: '60' },
      { value: 'vsync', label: '跟随屏幕' },
    ], 'data-fps');

    // ── 版本与更新 ──────────────────────────────────────────
    body.appendChild(el('div', { className: 'sf-section-label' }, '版本'));
    var versionRow = el('div', { className: 'sf-inline-row sf-version-row' });
    dom.versionText = el('span', { className: 'sf-version' }, 'v—');
    dom.checkUpdateBtn = el('button', { className: 'sf-ghost-btn', type: 'button' }, '检查更新');
    versionRow.appendChild(dom.versionText);
    versionRow.appendChild(dom.checkUpdateBtn);
    body.appendChild(versionRow);
    dom.updateStatus = el('div', { className: 'sf-note sf-update-status' }, '');
    body.appendChild(dom.updateStatus);
    // 只有发现新版本时才出现，平时不占位
    dom.downloadBtn = el('button', { className: 'sf-chip sf-active sf-download-btn', type: 'button' });
    dom.downloadBtn.style.display = 'none';
    body.appendChild(dom.downloadBtn);

    // ── 预设 ────────────────────────────────────────────────
    body.appendChild(el('div', { className: 'sf-section-label' }, '声场预设'));
    dom.presetRow = el('div', { className: 'sf-chips', id: 'sf-presets' });
    model.PRESETS.forEach(function (preset) {
      var chip = el('button', { className: 'sf-chip', type: 'button', 'data-preset': preset.id }, preset.display);
      dom.presetRow.appendChild(chip);
    });
    body.appendChild(dom.presetRow);

    // ── 连续参数滑杆 ────────────────────────────────────────
    body.appendChild(el('div', { className: 'sf-section-label' }, '声场参数'));
    dom.sliders = {};
    SLIDERS.forEach(function (def) {
      var row = el('div', { className: 'sf-row' });
      var top = el('div', { className: 'sf-row-head' });
      top.appendChild(el('span', { className: 'sf-row-label' }, def.label));
      var value = el('span', { className: 'sf-row-value' }, '');
      top.appendChild(value);
      row.appendChild(top);

      var input = el('input', {
        className: 'sf-range',
        type: 'range',
        min: String(def.min),
        max: String(def.max),
        step: String(def.step),
        'data-key': def.key,
      });
      row.appendChild(input);
      var scale = el('div', { className: 'sf-row-scale' });
      scale.appendChild(el('span', {}, def.left));
      scale.appendChild(el('span', {}, def.right));
      row.appendChild(scale);

      dom.sliders[def.key] = { input: input, value: value, def: def };
      body.appendChild(row);
    });

    // ── EQ ─────────────────────────────────────────────────
    var eqHead = el('div', { className: 'sf-section-head' });
    eqHead.appendChild(el('div', { className: 'sf-section-label' }, '10 段均衡器'));
    dom.eqToggle = el('button', { className: 'sf-mini-toggle', type: 'button', 'aria-pressed': 'true' }, 'EQ 开');
    eqHead.appendChild(dom.eqToggle);
    body.appendChild(eqHead);

    dom.eqRow = el('div', { className: 'sf-chips sf-chips-sm' });
    Object.keys(model.EQ_PRESETS).forEach(function (key) {
      var chip = el('button', { className: 'sf-chip', type: 'button', 'data-eq': key }, model.EQ_PRESETS[key].display);
      dom.eqRow.appendChild(chip);
    });
    body.appendChild(dom.eqRow);

    dom.eqGrid = el('div', { className: 'sf-eq-grid' });
    dom.eqSliders = [];
    model.EQ_FREQUENCIES.forEach(function (freq, index) {
      var cell = el('div', { className: 'sf-eq-cell' });
      // 频率标签：1kHz 以上用 k 写法，避免车机小屏挤成一行数字
      var label = freq >= 1000 ? (freq / 1000) + 'k' : String(freq);
      cell.appendChild(el('span', { className: 'sf-eq-freq' }, label));
      var slider = el('input', {
        className: 'sf-range sf-range-eq',
        type: 'range',
        min: '-12',
        max: '12',
        step: '0.5',
        'data-eq-index': String(index),
      });
      cell.appendChild(slider);
      var valueEl = el('span', { className: 'sf-eq-value' }, '0');
      cell.appendChild(valueEl);
      dom.eqSliders.push({ input: slider, value: valueEl });
      dom.eqGrid.appendChild(cell);
    });
    body.appendChild(dom.eqGrid);

    // ── 底部操作 ────────────────────────────────────────────
    var footer = el('footer', { className: 'sf-foot' });
    dom.status = el('div', { className: 'sf-status' }, '');
    footer.appendChild(dom.status);
    var footActions = el('div', { className: 'sf-foot-actions' });
    dom.modeBtn = el('button', { className: 'sf-ghost-btn', type: 'button' }, '声像：等功率');
    dom.resetBtn = el('button', { className: 'sf-ghost-btn', type: 'button' }, '恢复默认');
    footActions.appendChild(dom.modeBtn);
    footActions.appendChild(dom.resetBtn);
    footer.appendChild(footActions);
    // 底部操作条挂在面板上而不是滚动区里：车机上滚到一半也能点到「恢复默认」
    dom.panel.appendChild(body);
    dom.panel.appendChild(footer);
    dom.root = rootNode;
    rootNode.appendChild(dom.backdrop);
    rootNode.appendChild(dom.panel);
    rootNode.appendChild(dom.launcher);
    document.body.appendChild(rootNode);

    // 先按可见视口钉住根节点，再绑事件：否则面板会按 10000px 宽的布局视口居中，跑到屏幕外
    layoutRoot();
    applyCarPerformanceDefaults();
    bindEvents();
    refresh(engine.getParams());

    // 版本号：问原生拿 BuildConfig.VERSION_NAME，拿不到显示「未知」
    if (root.MRUpdater) {
      root.MRUpdater.getAppInfo().then(function () {
        var label = root.MRUpdater.currentVersionLabel();
        if (dom.versionText) dom.versionText.textContent = label === '未知' ? 'v未知' : ('v' + label);
      });
    }
  }

  /**
   * 读取可见视口。
   * Mineradio 会把布局视口放大到「屏宽/0.38」，真机上可能被夹到 10000px，
   * 所以只能用 visualViewport 拿「肉眼可见的那一块」，vw/vh 在这个页面里不可信。
   */
  function viewportMetrics() {
    var vv = window.visualViewport;
    if (vv && vv.width > 0) {
      return {
        left: vv.offsetLeft || 0,
        top: vv.offsetTop || 0,
        width: vv.width,
        height: vv.height,
        scale: vv.scale > 0 ? vv.scale : 1,
      };
    }
    return {
      left: 0,
      top: 0,
      width: window.innerWidth || 1,
      height: window.innerHeight || 1,
      scale: 1,
    };
  }

  /**
   * 把根节点钉在可见视口上，并按屏幕实际宽度换算「视觉像素」。
   * --sf-k = 1 视觉像素对应的布局像素数（= 1/scale），CSS 里所有固定尺寸都乘它。
   * 字号按屏幕宽度分档：2560 车机 18px、1280~1600 车机 16px、手机 15px。
   */
  function layoutRoot() {
    if (!dom.root) return;
    var m = viewportMetrics();
    var scale = m.scale;
    var screenWidth = m.width * scale; // 屏幕 CSS 宽（把布局像素换回肉眼像素）
    dom.root.style.left = m.left + 'px';
    dom.root.style.top = m.top + 'px';
    dom.root.style.width = m.width + 'px';
    dom.root.style.height = m.height + 'px';
    // 面板跟着「界面缩放」一起放大：否则整页放大 15% 后声场面板会显得明显偏小
    var zoom = (typeof window.__mrGetUiZoom === 'function') ? window.__mrGetUiZoom() : 1;
    dom.root.style.setProperty('--sf-k', String(zoom / scale));
    // 字号与触控高度按屏幕宽度分档：领克 08 车机 2560 宽 → 20px / 56px；
    // 手机 393 宽 → 15px / 36px。车机上手指更远、屏幕更大，控件必须跟着变大。
    var fontPx = Math.min(21, Math.max(15, screenWidth * 0.0078));
    var tapPx = Math.min(56, Math.max(36, screenWidth * 0.022));
    dom.root.style.setProperty('--sf-fs', ((fontPx * zoom) / scale) + 'px');
    dom.root.style.setProperty('--sf-tap', ((tapPx * zoom) / scale) + 'px');
    // 可见视口宽高比 ≥ 1.45 视为横屏（领克 08 车机 16:10 = 1.6），面板改右侧抽屉
    dom.root.classList.toggle('sf-drawer', (m.width / Math.max(1, m.height)) >= 1.45);
  }

  /** 打开面板：先同步一次参数，避免显示的是上次的旧值。 */
  function open() {
    build();
    // 每次打开都重算一次：车机可能在后台被旋转/分屏，账不能按打开时的尺寸算
    layoutRoot();
    refresh(engine.getParams());
    // 静默检查更新：内部有 24h 缓存，不会每次开面板都打 GitHub API
    if (!open.updateCheckedOnce) {
      open.updateCheckedOnce = true;
      runUpdateCheck(false);
    }
    dom.panel.classList.add('sf-show');
    dom.backdrop.classList.add('sf-show');
    dom.launcher.classList.add('sf-hidden');
  }

  /** 关闭面板：只做样式切换，不动音频。 */
  function close() {
    if (!built) return;
    dom.panel.classList.remove('sf-show');
    dom.backdrop.classList.remove('sf-show');
    dom.launcher.classList.remove('sf-hidden');
  }

  /**
   * 把参数写回界面控件。
   * 注意不能反过来触发 input 事件，否则会形成「刷新→写参数→刷新」的死循环。
   */
  function refresh(params) {
    if (!built) return;
    dom.enableBtn.textContent = params.enabled ? '已开启' : '已关闭';
    dom.enableBtn.setAttribute('aria-pressed', params.enabled ? 'true' : 'false');
    dom.enableBtn.classList.toggle('sf-off', !params.enabled);

    dom.vehicleSelect.value = params.vehicleId;
    var vehicle = model.getVehicle(params.vehicleId);
    var layout = engine.getLayout() || params.layout || vehicle.defaultLayout;
    dom.subtitle.textContent = layout + ' · ' + vehicle.speakerCount + ' 扬声器';
    dom.vehicleNote.textContent = vehicle.notes || ('默认布局 ' + vehicle.defaultLayout + '，共 ' + vehicle.speakerCount + ' 个扬声器');

    Array.prototype.forEach.call(dom.presetRow.children, function (chip) {
      chip.classList.toggle('sf-active', chip.getAttribute('data-preset') === params.presetId);
    });

    SLIDERS.forEach(function (def) {
      var box = dom.sliders[def.key];
      if (!box) return;
      box.input.value = String(params[def.key]);
      box.value.textContent = def.format(Number(params[def.key]));
    });

    dom.eqToggle.textContent = params.eqEnabled ? 'EQ 开' : 'EQ 关';
    dom.eqToggle.setAttribute('aria-pressed', params.eqEnabled ? 'true' : 'false');
    dom.eqToggle.classList.toggle('sf-off', !params.eqEnabled);
    params.eq.forEach(function (gain, index) {
      var cell = dom.eqSliders[index];
      if (!cell) return;
      cell.input.value = String(gain);
      cell.value.textContent = gain > 0 ? '+' + gain : String(gain);
    });

    // 界面缩放 / 画质 / 帧率：读应用侧真实状态，避免面板显示与生效值不一致
    var zoomNow = (typeof window.__mrGetUiZoom === 'function') ? window.__mrGetUiZoom() : 1;
    markChipActive(dom.zoomRow, function (chip) {
      return Math.abs(Number(chip.getAttribute('data-zoom')) - zoomNow) < 0.01;
    });
    var fxNow = window.fx || {};
    markChipActive(dom.qualityRow, function (chip) {
      return chip.getAttribute('data-quality') === (fxNow.performanceQuality || 'eco');
    });
    markChipActive(dom.fpsRow, function (chip) {
      return chip.getAttribute('data-fps') === (fxNow.foregroundFpsMode || 'vsync');
    });
    var particlesOn = !!(root.MRParticles && root.MRParticles.isEnabled());
    markChipActive(dom.particlesRow, function (chip) {
      return chip.getAttribute('data-particles') === (particlesOn ? 'on' : 'off');
    });

    dom.modeBtn.textContent = params.mode === 'hrtf' ? '声像：HRTF' : '声像：等功率';
    dom.status.textContent = engine.isAttached() ? '正在播放：参数实时生效' : '未开始播放：参数已保存，播放后生效';
  }

  /** 绑定所有交互；集中在一处，方便日后排查「点了没反应」是哪个元素没绑上。 */
  function bindEvents() {
    // 面板内的点击不要冒泡到播放器（否则会触发切歌/关面板等全局手势）
    ['pointerdown', 'touchstart', 'click'].forEach(function (type) {
      dom.panel.addEventListener(type, function (e) { e.stopPropagation(); }, { passive: true });
    });

    dom.launcher.addEventListener('click', function (e) {
      e.stopPropagation();
      open();
    });
    dom.closeBtn.addEventListener('click', close);
    dom.backdrop.addEventListener('click', close);

    dom.enableBtn.addEventListener('click', function () {
      var params = engine.getParams();
      refresh(engine.patch({ enabled: !params.enabled }));
    });

    dom.vehicleSelect.addEventListener('change', function () {
      refresh(engine.patch({ vehicleId: dom.vehicleSelect.value, layout: '' }));
    });

    dom.presetRow.addEventListener('click', function (e) {
      var chip = e.target.closest('[data-preset]');
      if (!chip) return;
      refresh(engine.applyPreset(chip.getAttribute('data-preset')));
    });

    SLIDERS.forEach(function (def) {
      var box = dom.sliders[def.key];
      box.input.addEventListener('input', function () {
        var value = Number(box.input.value);
        box.value.textContent = def.format(value);
        // 手动拖滑杆即视为自定义：把预设标记切到「默认」之外的 custom 状态
        engine.patch({ presetId: 'custom', [def.key]: value });
        highlightCustom();
      });
    });

    dom.eqToggle.addEventListener('click', function () {
      var params = engine.getParams();
      refresh(engine.patch({ eqEnabled: !params.eqEnabled }));
    });

    dom.eqRow.addEventListener('click', function (e) {
      var chip = e.target.closest('[data-eq]');
      if (!chip) return;
      var preset = model.EQ_PRESETS[chip.getAttribute('data-eq')];
      if (!preset) return;
      engine.patch({ eq: preset.gains.slice(), eqEnabled: true, presetId: 'custom' });
      highlightCustom();
      refresh(engine.getParams());
    });

    dom.eqSliders.forEach(function (cell, index) {
      cell.input.addEventListener('input', function () {
        var gains = engine.getParams().eq.slice();
        gains[index] = Number(cell.input.value);
        cell.value.textContent = gains[index] > 0 ? '+' + gains[index] : String(gains[index]);
        engine.patch({ eq: gains, eqEnabled: true, presetId: 'custom' });
        highlightCustom();
      });
    });

    // 界面缩放：调用 index.html 暴露的接口，改完立刻重排整页
    dom.zoomRow.addEventListener('click', function (e) {
      var chip = e.target.closest('[data-zoom]');
      if (!chip || typeof window.__mrSetUiZoom !== 'function') return;
      window.__mrSetUiZoom(Number(chip.getAttribute('data-zoom')));
      setTimeout(function () {
        layoutRoot();
        refresh(engine.getParams());
      }, 120);
    });

    // 画质：调上游的 setPerformanceQualityMode，保证和 fx 面板同一条持久化路径
    dom.qualityRow.addEventListener('click', function (e) {
      var chip = e.target.closest('[data-quality]');
      if (!chip || typeof setPerformanceQualityMode !== 'function') return;
      setPerformanceQualityMode(chip.getAttribute('data-quality'), true);
      refresh(engine.getParams());
    });

    // 帧率上限：车机上固定 45 通常比跟随 60 明显省电，画面几乎看不出差别
    // 粒子效果：默认关闭。关闭时 GPU 不再遍历任何粒子顶点，是车机上最直接的一刀
    dom.particlesRow.addEventListener('click', function (e) {
      var chip = e.target.closest('[data-particles]');
      if (!chip || !root.MRParticles) return;
      root.MRParticles.setEnabled(chip.getAttribute('data-particles') === 'on');
      refresh(engine.getParams());
    });

    dom.fpsRow.addEventListener('click', function (e) {
      var chip = e.target.closest('[data-fps]');
      if (!chip || typeof setForegroundFpsMode !== 'function') return;
      setForegroundFpsMode(chip.getAttribute('data-fps'), true);
      refresh(engine.getParams());
    });

    // 整页重排后（缩放变化）面板要重新钉回可见视口
    window.addEventListener('mineradio-ui-zoom', function () { setTimeout(layoutRoot, 60); });

    // 检查更新：打 GitHub Release，再决定是提示「已是最新」还是给下载按钮
    dom.checkUpdateBtn.addEventListener('click', function () {
      runUpdateCheck(true);
    });

    // 下载并安装：走原生 DownloadManager，完成后系统安装器自动弹出
    dom.downloadBtn.addEventListener('click', async function () {
      if (!root.MRUpdater) return;
      // GitHub 不可达时这个按钮是「打开发布页」，不是下载
      if (dom.downloadBtn.getAttribute('data-update-action') === 'page') {
        try {
          await root.MRUpdater.openReleasePage();
          dom.updateStatus.textContent = '已打开发布页面';
        } catch (e) {
          dom.updateStatus.textContent = '无法打开链接：' + (e && e.message ? e.message : '未知错误');
        }
        return;
      }
      dom.downloadBtn.disabled = true;
      var original = dom.downloadBtn.textContent;
      dom.downloadBtn.textContent = '下载中…';
      dom.updateStatus.textContent = '正在下载安装包，完成后会自动弹出安装界面';
      try {
        var res = await root.MRUpdater.download();
        if (res && res.status === 'completed') {
          dom.updateStatus.textContent = '下载完成，请按系统提示安装';
        } else if (res && res.status === 'opened') {
          dom.updateStatus.textContent = '已打开下载页面';
        }
      } catch (e) {
        dom.updateStatus.textContent = '下载失败：' + (e && e.message ? e.message : '未知错误');
      } finally {
        dom.downloadBtn.disabled = false;
        dom.downloadBtn.textContent = original;
      }
    });

    dom.modeBtn.addEventListener('click', function () {
      var params = engine.getParams();
      refresh(engine.patch({ mode: params.mode === 'hrtf' ? 'equalpower' : 'hrtf' }));
    });

    dom.resetBtn.addEventListener('click', function () {
      refresh(engine.reset());
    });

    // 引擎侧参数变化（例如别的入口改了参数）也要同步界面
    engine.onChange(function (params) { refresh(params); });

    // 关闭面板不阻止播放，但要把焦点还给播放器，避免滑杆吞掉方向键
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && built && dom.panel.classList.contains('sf-show')) close();
    });

    // 视口变化要跟着重钉：横竖屏切换、车机分屏、软键盘弹出都会改可见视口
    window.addEventListener('resize', layoutRoot);
    window.addEventListener('orientationchange', function () { setTimeout(layoutRoot, 150); });
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', layoutRoot);
      window.visualViewport.addEventListener('scroll', layoutRoot);
    }
  }

  /**
   * 检查更新并刷新界面。
   * force=true 时跳过 24h 缓存（用户主动点「检查更新」）。
   */
  async function runUpdateCheck(force) {
    var updater = root.MRUpdater;
    if (!updater) {
      dom.updateStatus.textContent = '更新模块未加载';
      return;
    }
    dom.checkUpdateBtn.disabled = true;
    var label = dom.checkUpdateBtn.textContent;
    dom.checkUpdateBtn.textContent = '检查中…';
    dom.updateStatus.textContent = '正在连接 GitHub…';
    try {
      var res = await updater.check({ force: !!force });
      renderUpdate(res);
    } catch (e) {
      dom.updateStatus.textContent = '检查失败：' + (e && e.message ? e.message : '网络异常');
    } finally {
      dom.checkUpdateBtn.disabled = false;
      dom.checkUpdateBtn.textContent = label;
    }
  }

  /** 把检查结果渲染成一行状态 + 一个（可能出现的）下载按钮。 */
  function renderUpdate(res) {
    if (!res) return;
    if (res.current && res.current.versionName) {
      dom.versionText.textContent = 'v' + res.current.versionName;
    }
    dom.downloadBtn.style.display = 'none';

    if (res.error) {
      // GitHub 在部分车机网络下不可达：给一个「打开发布页」的兜底，而不是只报错
      dom.updateStatus.textContent = res.error;
      dom.downloadBtn.textContent = '打开发布页面';
      dom.downloadBtn.setAttribute('data-update-action', 'page');
      dom.downloadBtn.style.display = '';
      return;
    }
    if (!res.latest) {
      dom.updateStatus.textContent = '未获取到发布信息';
      return;
    }
    var size = root.MRUpdater ? root.MRUpdater.formatSize(res.latest.apkSize) : '';
    if (!res.current || !res.current.versionName) {
      // 网页预览/读不到版本时不能硬说「已是最新」，如实显示最新发布号
      dom.updateStatus.textContent = '最新发布 ' + res.latest.tag + (size ? '（' + size + '）' : '') + '；本机版本未知';
      return;
    }
    if (res.hasUpdate) {
      dom.updateStatus.textContent = '发现新版本 ' + res.latest.tag + (size ? '（' + size + '）' : '');
      dom.downloadBtn.textContent = '下载并安装 ' + res.latest.tag;
      dom.downloadBtn.setAttribute('data-update-action', 'download');
      dom.downloadBtn.style.display = '';
    } else {
      dom.updateStatus.textContent = '已是最新版本（' + res.latest.tag + '）';
    }
  }

  /** 按条件给 chip 组打高亮（没有匹配项时全部取消）。 */
  function markChipActive(row, predicate) {
    if (!row) return;
    Array.prototype.forEach.call(row.children, function (chip) {
      chip.classList.toggle('sf-active', !!predicate(chip));
    });
  }

  /**
   * 首次启动的车机性能默认值。
   * 只动「还是上游默认值」的项：用户自己调过 fps 就不覆盖。
   * 画质保持上游默认的 eco；这里把帧率从「跟随屏幕」降到 45 ——
   * 车机上 45fps 与 60fps 的粒子观感差异很小，但每帧的 CPU 开销少 25%。
   */
  function applyCarPerformanceDefaults() {
    var MARKER = 'mineradio-soundfield-perf-v1';
    try {
      if (localStorage.getItem(MARKER)) return;
      localStorage.setItem(MARKER, '1');
    } catch (e) {
      return;
    }
    var fxNow = window.fx || {};
    if (typeof setForegroundFpsMode === 'function' && (!fxNow.foregroundFpsMode || fxNow.foregroundFpsMode === 'vsync')) {
      setForegroundFpsMode('45', true);
    }
  }

  /**
   * 自定义参数时清掉预设高亮。
   * 预设列表里没有 custom 这一项，所以全部取消高亮即可表达「自定义」。
   */
  function highlightCustom() {
    if (!built) return;
    Array.prototype.forEach.call(dom.presetRow.children, function (chip) {
      chip.classList.remove('sf-active');
    });
  }

  // 启动即挂悬浮入口，不等用户先播放；音频未就绪时参数照样能存
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', build);
  } else {
    build();
  }

  // 交给控制台调试用
  root.MRSoundFieldPanel = { open: open, close: close };
})(window);
