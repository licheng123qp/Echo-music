// tests/cdp-layout-audit.js
// 用 CDP 设备模拟（mobile=true，DPR 真实）测量声场面板与 Mineradio 原生控件的实际视觉尺寸。
//
// 为什么需要它：
//   Mineradio 在 index.html 里把布局视口设成「屏宽/0.38」再用 initial-scale=0.38 缩回去，
//   普通桌面浏览器的 headless 不会应用 meta viewport，测出来的尺寸会骗人。
//   这里用 DevTools 协议的移动端模拟，才会走和真机 Android WebView 一样的缩放路径。
//
// 用法：node tests/cdp-layout-audit.js [url] [width] [height] [dpr]

'use strict';

const url = process.argv[2] || 'http://127.0.0.1:8765/index.html';
const width = Number(process.argv[3] || 393);
const height = Number(process.argv[4] || 873);
const dpr = Number(process.argv[5] || 2.75);

/** 发一条 CDP 命令并等结果。 */
function cdp(ws, id, method, params) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('CDP timeout: ' + method)), 30000);
    const onMessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id !== id) return;
      clearTimeout(timer);
      ws.removeEventListener('message', onMessage);
      if (msg.error) reject(new Error(method + ': ' + msg.error.message));
      else resolve(msg.result);
    };
    ws.addEventListener('message', onMessage);
    ws.send(JSON.stringify({ id, method, params: params || {} }));
  });
}

/** 在页面里求值，返回 JSON 值。 */
async function evaluate(ws, nextId, expression) {
  const result = await cdp(ws, nextId(), 'Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (result.exceptionDetails) {
    throw new Error('页面执行出错: ' + JSON.stringify(result.exceptionDetails.exception));
  }
  return result.result.value;
}

(async () => {
  // 1) 新建标签页并连上它的 WebSocket
  const target = await fetch('http://127.0.0.1:9222/json/new?about:blank', { method: 'PUT' }).then((r) => r.json());
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve);
    ws.addEventListener('error', reject);
  });

  let id = 0;
  const nextId = () => ++id;

  // 2) 打开移动端模拟：这一步决定 meta viewport 是否生效
  await cdp(ws, nextId(), 'Page.enable');
  await cdp(ws, nextId(), 'Runtime.enable');
  await cdp(ws, nextId(), 'Emulation.setDeviceMetricsOverride', {
    width, height, deviceScaleFactor: dpr, mobile: true,
  });

  // 3) 加载并等待应用启动（首屏有 3D/粒子初始化，给足时间）
  await cdp(ws, nextId(), 'Page.navigate', { url });
  await new Promise((r) => setTimeout(r, 12000));

  // 4) 测量：应用自己的控件 vs 声场面板
  // 打开面板后要等 0.2s 的 transform 过渡结束，否则量到的是旧位置
  await evaluate(ws, nextId, `(() => { if (window.MRSoundFieldPanel) window.MRSoundFieldPanel.open(); return true; })()`);
  await new Promise((r) => setTimeout(r, 700));

  const report = await evaluate(ws, nextId, `(() => {
    const q = (sel) => document.querySelector(sel);
    const rect = (sel) => {
      const n = q(sel);
      if (!n) return null;
      const r = n.getBoundingClientRect();
      const cs = getComputedStyle(n);
      return {
        w: +r.width.toFixed(1), h: +r.height.toFixed(1),
        left: +r.left.toFixed(1), top: +r.top.toFixed(1),
        fontSize: cs.fontSize,
      };
    };
    const probe = {
      // 真机视觉尺寸 = 布局尺寸 x 视觉缩放（视觉视口宽 / 布局视口宽）
      innerWidth: window.innerWidth,
      clientWidth: document.documentElement.clientWidth,
      screenWidth: window.screen.width,
      dpr: window.devicePixelRatio,
      app: {
        titlebar: rect('#desktop-titlebar'),
        iconBtn: rect('#visual-guide-btn'),
        bodyFont: getComputedStyle(document.body).fontSize,
      },
      panel: {
        root: rect('#sf-panel'),
        launcher: rect('#sf-launcher'),
        title: rect('.sf-title'),
        chip: rect('#sf-presets .sf-chip'),
        range: rect('.sf-row .sf-range'),
        select: rect('#sf-vehicle'),
        close: rect('.sf-close'),
        eqCell: rect('.sf-eq-cell'),
        statusText: rect('.sf-status'),
      },
    };
    // 视觉视口宽（= 屏幕 CSS 宽），用来把布局 px 换算成真机可见 px
    const vv = window.visualViewport;
    probe.visualViewport = vv ? {
      width: +vv.width.toFixed(1), height: +vv.height.toFixed(1),
      scale: +vv.scale.toFixed(3), offsetLeft: +vv.offsetLeft.toFixed(1), offsetTop: +vv.offsetTop.toFixed(1),
    } : null;
    probe.rootClass = document.querySelector('#sf-root') ? document.querySelector('#sf-root').className : null;
    // 布局 px → 肉眼 px：乘 visualViewport.scale
    const sc = vv ? vv.scale : 1;
    const toVisual = (r) => r ? {
      w: +(r.w * sc).toFixed(1), h: +(r.h * sc).toFixed(1),
      left: +(r.left * sc).toFixed(1), top: +(r.top * sc).toFixed(1),
    } : null;
    probe.visual = {
      viewport: vv ? { w: Math.round(vv.width * sc), h: Math.round(vv.height * sc) } : null,
      panel: toVisual(probe.panel.root),
      launcher: toVisual(probe.panel.launcher),
      chip: toVisual(probe.panel.chip),
      range: toVisual(probe.panel.range),
      eqCell: toVisual(probe.panel.eqCell),
    };
    return probe;
  })()`);

  console.log(JSON.stringify(report, null, 2));
  ws.close();
  await fetch('http://127.0.0.1:9222/json/close/' + target.id);
})().catch((err) => {
  console.error('审计失败:', err.message);
  process.exit(1);
});
