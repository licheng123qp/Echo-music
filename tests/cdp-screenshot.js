// tests/cdp-screenshot.js
// 在设备模拟里截图，返回 PNG 文件路径。用于「看不见/颜色不对」这类只能看图判断的问题。
// 用法：node tests/cdp-screenshot.js [url] [w] [h] [dpr] [输出路径] [强制显示的额外 CSS]

'use strict';
const fs = require('fs');

const url = process.argv[2] || 'http://127.0.0.1:8765/index.html';
const width = Number(process.argv[3] || 2560);
const height = Number(process.argv[4] || 1600);
const dpr = Number(process.argv[5] || 1);
const out = process.argv[6] || '/tmp/app-shot.png';
const extraCss = process.argv[7] || '';

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

(async () => {
  const target = await fetch('http://127.0.0.1:9222/json/new?about:blank', { method: 'PUT' }).then((r) => r.json());
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  let id = 0;
  const nextId = () => ++id;
  await cdp(ws, nextId(), 'Page.enable');
  await cdp(ws, nextId(), 'Runtime.enable');
  await cdp(ws, nextId(), 'Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: dpr, mobile: true });
  await cdp(ws, nextId(), 'Page.navigate', { url });
  await new Promise((r) => setTimeout(r, 10000));
  if (extraCss) {
    await cdp(ws, nextId(), 'Runtime.evaluate', { expression: `(() => { const s = document.createElement('style'); s.textContent = ${JSON.stringify(extraCss)}; document.head.appendChild(s); return true; })()` });
    await new Promise((r) => setTimeout(r, 800));
  }
  const shot = await cdp(ws, nextId(), 'Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(out, Buffer.from(shot.data, 'base64'));
  console.log('saved', out);
  ws.close();
})().catch((e) => { console.error('失败:', e.message); process.exit(1); });
