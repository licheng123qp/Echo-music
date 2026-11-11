# 领克 08 声场设计说明

本文说明「声场」在 Mineradio 声场版里到底做了什么、参数怎么来的、为什么这么取。
面向要改参数或移植到别的车型的人。

## 1. 问题定义

车机上的「声场控制」通常指三件事：

1. **座位/声像**：声音从哪个方向来（主驾、全车、后排）。
2. **包围感**：侧后方与顶置扬声器参与多少。
3. **音色**：EQ 与低频管理。

领克 08 是 23 扬声器、含 4 个顶置声道的 7.1.4 系统（见 `www/js/soundfield/00-vehicle-model.js`
里 `lynk-08` 的档案）。车机本身会做一次上混，第三方播放器**拿不到**那条多声道总线，
所以这里做的是「在立体声出口前，把声像和包围感先渲染好」——交给车机的是已经带空间信息的
立体声，而不是让车机从零上混。

## 2. 为什么放在 Web Audio

| 方案 | 可行性 | 结论 |
| --- | --- | --- |
| 原生 AudioEffect（`Equalizer` / `Virtualizer`） | WebView 的音频不暴露 sessionId，挂不上 | ✗ |
| 原生 Media3 + AudioProcessor 播放 | 需要替换整个播放器（前端逻辑全在 JS，含节拍分析） | 成本过高 |
| AudioPlaybackCapture 录制再渲染 | 需要录屏授权、有回环风险、延迟不可控 | ✗ |
| **Web Audio 图内插 DSP** | 播放器本来就是 `MediaElementSource → analyser → gain → destination` | ✓ 采用 |

因此入口只有一处：`www/js/modules/05-playback/08-audio-graph-controls.js` 里
`gainNode.connect(destination)` 改成 `gainNode.connect(MRSoundField.outputNode(ctx))`。

## 3. 信号链

```
                 ┌──────────── 每声道 10 段 EQ ────────────┐
input → preGain → splitter(L/R) → [31..16k Biquad] → gainL/R → merger
                                                              │
                 ┌──────────────── M/S 分解 ──────────────────┤
                 │  M = (L+R)/2    S = (L−R)/2                │
                 ▼                                            │
   ┌─────────────┼───────────────┬──────────────────┐         │
   │ 宽度         │ 虚拟中置       │ 环绕              │ 高度     │
   │ L=M+wS      │ M→Panner(0°)  │ S→Delay→LP→Panner(±110°) │ M→HP→Delay→Panner(±50°,+45°) │
   └─────────────┴───────────────┴──────────────────┘         │
                              ▼                               ▼
                        限幅器(DynamicsCompressor) → destination
```

关键点：

- **宽度**用 M/S 矩阵而不是 Haas 延迟。M/S 是线性、无相位问题的，宽度 0 时严格退化为单声道，
  不会像延迟法那样在单声道设备上抵消。
- **虚拟中置**把 mid 抽 75% 送到 0° 声像，同时用 `postGain` 压低直达声，
  避免「中置一开人声变糊」。这是 7.1.4 里 FC 的作用。
- **环绕**走 side 信号 + 12–24ms 延迟 + 7kHz 低通，再送到 ±110°。延迟量随车型
  `cabinWidth` 缩放（领克 08 是 1.5m，延迟约 24ms），对应「从后舱绕过来」的传播时间。
- **高度**只取 mid 的 2.2kHz 以上部分（人耳对高频的垂直定位更敏感），延迟 6ms 后送到
  仰角 45°、方位 ±50° 的声像；布局不含顶置声道（如 2.0/5.1）时该路自动静音。
- **限幅器**阈值 −2dB、比率 20:1，只做安全兜底；正常听音不会触发。

## 4. 参数与预设

| 参数 | 范围 | 默认 | 作用 |
| --- | --- | --- | --- |
| `width` | 0–2 | 1.0 | M/S 中 S 的增益；1.0 为原始立体声 |
| `center` | 0–1 | 0.15 | 中置抽头量（×0.75 后送声像） |
| `surround` | 0–1 | 0.30 | 环绕路电平，叠加 `fader` 的后排偏置 |
| `height` | 0–1 | 0.15 | 顶置路电平，仅在含顶置声道的布局生效 |
| `balance` | −100–100 | 0 | 左右等功率压一侧 |
| `fader` | −100–100 | 0 | >0 偏前排；同时提高直达声、降低环绕占比 |
| `eq` | −12–12 dB ×10 | 全 0 | 31Hz…16kHz |

预设与 FXPlayer `ScenePreset` 对齐：`default` / `auto-immersive` / `driver-first` /
`cabin-balanced` / `surround-7.1.4` / `stereo`。其中：

- `auto-immersive` 走 `resolveAutoLayout()`：取车型白名单里声道数最多的布局。
  领克 08 的 `preferMax=true` 就是为这条规则存在的（其余车型取「够用」）。
- `driver-first` 的增益曲线来自原工程的 `GainProfile.DRIVER`（主驾声像居中、后排 −6dB），
  映射到 Web 端是「提高 center + fader 前移 + 人声段 EQ +3dB」。
- `cabin-balanced` 对应 `GainProfile.BALANCED`（前后等功率），映射为更大的 width/surround。

用户手动拖任一参数后，`presetId` 置为 `custom`，避免界面继续高亮某个预设造成误导。

## 5. 自动增益补偿

四路叠加会抬高响度，`postGain` 按下面公式反比压回：

```
energy = 1 + (width−1)·0.30 + center·0.22 + surroundLevel·0.25 + heightLevel·0.18
makeup = clamp(1 / max(1, energy), 0.45, 1)
```

系数是用粉噪/扫频在桌面端试出来的经验值，目标是「切换预设时响度变化 < 2dB」，
不追求绝对精确——精确响度交给限幅器。

## 6. 性能

- 默认 `equalpower` 声像：5 个 Panner 都是低成本等功率，实测中端车机 CPU 占用可忽略。
- `hrtf` 模式会给每个 Panner 加载 HRTF 脉冲响应，低端车机可能掉帧，面板里可切换。
- EQ 是 20 个 Biquad（左右各 10），Web Audio 内部会优化串联链，开销远小于 20 个独立节点。
- 所有参数变更只写 AudioParam（`setTargetAtTime`，时间常数 20ms），不重建节点，所以不会爆音。

## 7. 移植到其他车型

1. 在 `00-vehicle-model.js` 的 `VEHICLES` 里加档案：`speakerCount`、`layouts`、`defaultLayout`、
   `cabinWidth`（影响环绕延迟）、`preferMax`。
2. 若车型声道位置与 `SPEAKER_GEOMETRY` 差异大（例如中置更靠前），改坐标即可，
   不影响 DSP 结构。
3. 想加新预设：在 `PRESETS` 里加一条，`params` 里的六个数就是全部可调项。
4. 跑 `node tests/soundfield-engine-test.js` 确认建图与参数夹取没被改坏。
