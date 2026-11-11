// tests/cdp-eval.js
// 在 CDP 模拟的真机环境里执行任意表达式，返回 JSON。
// 用法：node tests/cdp-eval.js '<表达式>' [url] [w] [h] [dpr]
// 主要给排查布局问题用（比如「面板为什么不居中」），不参与构建。

'use strict';

const expression = process.argv[2];
const url = process.argv[3] || 'http://127.0.0.1:8765/index.html';
const width = Number(process.argv[4] || 393);
const height = Number(process.argv[5] || 873);
const dpr = Number(process.argv[6] || 2.75);

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
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve);
    ws.addEventListener('error', reject);
  });
  let id = 0;
  const nextId = () => ++id;
  await cdp(ws, nextId(), 'Runtime.enable');
  await cdp(ws, nextId(), 'Page.enable');
  await cdp(ws, nextId(), 'Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: dpr, mobile: true });
  await cdp(ws, nextId(), 'Page.navigate', { url });
  await new Promise((r) => setTimeout(r, 10000));
  const res = await cdp(ws, nextId(), 'Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  console.log(JSON.stringify(res.result && res.result.value, null, 2));
  if (res.exceptionDetails) console.error(JSON.stringify(res.exceptionDetails, null, 2));
  ws.close();
})().catch((err) => { console.error('失败:', err.message); process.exit(1); });
