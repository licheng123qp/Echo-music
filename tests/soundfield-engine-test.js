// tests/soundfield-engine-test.js
// 声场引擎的离线自检：用假的 AudioContext 跑一遍建图与参数应用。
//
// 为什么值得单独写：声场链有 30+ 个节点、5 个 Panner，一旦某个节点名写错（比如
// createPanner 拼成 createPannerNode），只有真机播放时才炸，而且表现是「整首歌没声」。
// 这个脚本在 CI/本地就能把这类错误挡下来。

'use strict';

const path = require('path');
const fs = require('fs');

/** 极简 AudioParam：记录最后一次 setTargetAtTime/value，供断言。 */
class FakeParam {
  constructor(value) {
    this.value = value;
    this.history = [];
  }
  setTargetAtTime(value) {
    this.value = value;
    this.history.push(value);
  }
}

/** 极简 AudioNode：只要能被 connect/disconnect，参数能被写。 */
class FakeNode {
  constructor(kind) {
    this.kind = kind;
    this.connections = [];
  }
  connect(target) {
    this.connections.push(target);
    return target;
  }
  disconnect() {
    this.connections = [];
  }
}

class FakeGain extends FakeNode {
  constructor() {
    super('gain');
    this.gain = new FakeParam(1);
  }
}

class FakeFilter extends FakeNode {
  constructor() {
    super('filter');
    this.type = 'peaking';
    this.frequency = new FakeParam(350);
    this.Q = new FakeParam(1);
    this.gain = new FakeParam(0);
  }
}

class FakePanner extends FakeNode {
  constructor() {
    super('panner');
    this.panningModel = 'equalpower';
    this.distanceModel = 'inverse';
    this.refDistance = 1;
    this.maxDistance = 10000;
    this.rolloffFactor = 1;
    this.positionX = new FakeParam(0);
    this.positionY = new FakeParam(0);
    this.positionZ = new FakeParam(0);
  }
  setPosition(x, y, z) {
    this.positionX.value = x;
    this.positionY.value = y;
    this.positionZ.value = z;
  }
}

class FakeSplitter extends FakeNode {
  constructor() { super('splitter'); }
}

class FakeMerger extends FakeNode {
  constructor() { super('merger'); }
}

class FakeDelay extends FakeNode {
  constructor() {
    super('delay');
    this.delayTime = new FakeParam(0);
  }
}

class FakeCompressor extends FakeNode {
  constructor() {
    super('compressor');
    this.threshold = new FakeParam(-24);
    this.knee = new FakeParam(30);
    this.ratio = new FakeParam(12);
    this.attack = new FakeParam(0.003);
    this.release = new FakeParam(0.25);
  }
}

class FakeAudioContext {
  constructor() {
    this.currentTime = 0;
    this.state = 'running';
    this.destination = new FakeNode('destination');
    this.nodes = [];
  }
  _track(node) { this.nodes.push(node); return node; }
  createGain() { return this._track(new FakeGain()); }
  createBiquadFilter() { return this._track(new FakeFilter()); }
  createPanner() { return this._track(new FakePanner()); }
  createChannelSplitter() { return this._track(new FakeSplitter()); }
  createChannelMerger() { return this._track(new FakeMerger()); }
  createDelay() { return this._track(new FakeDelay()); }
  createDynamicsCompressor() { return this._track(new FakeCompressor()); }
}

/** localStorage 打桩，引擎会读存档。 */
const store = new Map();
const localStorageStub = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};

global.window = {
  localStorage: localStorageStub,
  AudioContext: FakeAudioContext,
  console,
};
global.localStorage = localStorageStub;

const base = path.join(__dirname, '..', 'www', 'js', 'soundfield');
// 用 vm 顺序加载，模拟浏览器里的 <script> 顺序
const vm = require('vm');
const sandbox = {
  window: global.window,
  console,
  localStorage: localStorageStub,
  Math,
  Number,
  Object,
  Array,
  JSON,
  isFinite,
  String,
  Boolean,
};
sandbox.window.MRSoundFieldModel = undefined;
vm.createContext(sandbox);
for (const file of ['00-vehicle-model.js', '10-soundfield-engine.js']) {
  const code = fs.readFileSync(path.join(base, file), 'utf8');
  vm.runInContext(code, sandbox, { filename: file });
}

const model = sandbox.window.MRSoundFieldModel;
const sf = sandbox.window.MRSoundField;

const failures = [];
function check(name, condition, detail) {
  if (condition) {
    console.log('  ✓ ' + name);
  } else {
    failures.push(name + (detail ? ' — ' + detail : ''));
    console.log('  ✗ ' + name + (detail ? ' — ' + detail : ''));
  }
}

console.log('车型模型');
check('领克 08 存在且为 23 扬声器', model.getVehicle('lynk-08').speakerCount === 23);
check('领克 08 默认布局 7.1.4', model.getVehicle('lynk-08').defaultLayout === '7.1.4');
check('未识别车型回退到 other', model.getVehicle('not-exist').id === 'other');
check('自动全景声为领克 08 选 7.1.4', model.resolveAutoLayout(model.getVehicle('lynk-08'), model.getVehicle('lynk-08').layouts) === '7.1.4');
check('9.1.4 只在领克 900 白名单内', model.getVehicle('lynk-900').layouts.includes('9.1.4') && !model.getVehicle('lynk-08').layouts.includes('9.1.4'));
check('EQ 有 10 段', model.EQ_FREQUENCIES.length === 10);

console.log('引擎建图与参数');
const ctx = new FakeAudioContext();
const input = sf.outputNode(ctx);
check('outputNode 返回可连接节点', input && typeof input.connect === 'function');
// 20 个 EQ 滤波 + 环绕低通 + 高度高通 = 22 个 BiquadFilter
check('已创建 10 段 EQ × 2 声道 + 2 个分频滤波', ctx.nodes.filter((n) => n.kind === 'filter').length === 22);
check('已创建 5 个声像节点', ctx.nodes.filter((n) => n.kind === 'panner').length === 5);

// 默认参数开启时，input 应接到 preGain 而不是 destination
check('默认启用时 input 不直连 destination', input.connections.every((n) => n.kind !== 'destination'));

// 关闭后应回到直通
sf.patch({ enabled: false });
check('关闭声场后直连 destination', input.connections.some((n) => n.kind === 'destination'));

// 重新开启并调参
sf.patch({ enabled: true, width: 1.8, center: 0.5, surround: 0.8, height: 0.6, balance: -100, fader: 50 });
const params = sf.getParams();
check('宽度写入参数', params.width === 1.8);
check('左右平衡 -100 只剩左声道', sf._debug().engine.gainR.gain.value < 0.01, String(sf._debug().engine.gainR.gain.value));
check('布局解析为 7.1.4', sf.getLayout() === '7.1.4');

// 脏数据必须被夹回合法区间，不能把 AudioParam 写成 NaN
sf.patch({ width: 99, center: -5, balance: 999, eq: [99] });
const dirty = sf.getParams();
check('宽度越界被夹到 2', dirty.width === 2);
check('中置越界被夹到 0', dirty.center === 0);
check('平衡越界被夹到 100', dirty.balance === 100);
check('EQ 越界被夹到 12 且补足 10 段', dirty.eq[0] === 12 && dirty.eq.length === 10);

// 预设切换：驾驶位优先应把 fader 推到前排
sf.applyPreset('driver-first');
check('驾驶位优先把声像推向前排', sf.getParams().fader > 0);

// 自定义参数不应被夹回 default
sf.patch({ width: 1.2 });
check('手动调参后标记为 custom', sf.getParams().presetId === 'custom', sf.getParams().presetId);

// 换 AudioContext 后必须重建（播放器恢复音频图时会换 ctx）
const ctx2 = new FakeAudioContext();
sf.outputNode(ctx2);
check('新 AudioContext 会重建引擎链', sf._debug().engine.ctx === ctx2);

sf.patch({ enabled: false });
check('引擎关闭状态可持久化', JSON.parse(localStorageStub.getItem('mineradio_soundfield_v1')).enabled === false);

console.log('');
if (failures.length) {
  console.error('失败 ' + failures.length + ' 项：');
  failures.forEach((f) => console.error(' - ' + f));
  process.exit(1);
}
console.log('全部通过');
