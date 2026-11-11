# Mineradio 声场版（Mineradio SoundField）

> 基于 [Mineradio](https://github.com/XxHuberrr/Mineradio-paused) 安卓版前端重建的 **Android 工程**，并加入**领克 08 声场控制**：车型匹配、7.1.4 虚拟声场、左右/前后平衡、声场宽度、虚拟中置、10 段 EQ。
>
> **本项目是第三方衍生版，不是 Mineradio 官方版本。** 原项目版权归 [XxHuberrr](https://github.com/XxHuberrr) 所有，按 GPL-3.0 授权。

---

## 1. 这是什么

Mineradio 官方安卓版（v2.2.0）以 APK 形式分发，仓库里公开的是 Windows/Electron 版本源码，**没有 Android 工程**。本仓库做了两件事：

1. **把安卓版还原成可编译的工程**
   从官方 APK 中提取 Web 前端（`www/`，含 `android-shim` 与 Folia 可视化），用 Capacitor 6 重建 Android 外壳，并实现了前端依赖的原生网络桥 `FoliaBridge`（OkHttp）。现在可以用 Android Studio / Gradle 直接构建出 APK。
2. **加入「领克 08 声场」**
   车型与预设口径移植自 [FXPlayer / 声场 SoundField](https://github.com/licheng123qp/FXPlayer) 的 `audio-model`（19 声道单元、7.1.4 布局、车型档案），在 Web Audio 链路上实现真正的 DSP：不是贴一层 EQ，而是把立体声重新渲染成「虚拟 7.1.4 声场」再下混。

> 为什么声场做在 Web 层：安卓 WebView 的音频由 Chromium 混音，原生侧拿不到 PCM，无法插 AudioEffect；而播放器的音频已经跑在 Web Audio 图里（`source → analyser → gain → destination`），把主总线改接到声场链即可，零重启、实时调参。

## 2. 声场功能

| 模块 | 说明 |
| --- | --- |
| 车型匹配 | 领克 08（23/25 款、26 款）、领克 07、Z20、10 EM-P、900、星耀 8、银河 E5 等；每个车型带扬声器数量、可用布局白名单、默认布局、车舱宽度 |
| 布局 | 2.0 / 4.0 / 5.1 / 5.1.2 / 5.1.4 / 6.1 / 7.1 / 7.1.2 / 7.1.4 / 9.1.4；领克 08 默认 7.1.4（23 扬声器） |
| 声场预设 | 默认、自动全景声、驾驶位优先、全车均衡、7.1.4 环绕、2.0 纯直通；拖动任一参数自动标记「自定义」 |
| 连续参数 | 声场宽度 0–200%、虚拟中置 0–100%、环绕强度、高度感、左右平衡、前后声场 |
| 均衡器 | 10 段（31Hz–16kHz，±12dB），6 条预设曲线（平直/流行/古典/人声/低音/高音） |
| 声像模式 | 等功率（默认，省 CPU）/ HRTF（沉浸，开销大，车机建议慎用） |
| 持久化 | 全部参数存 `localStorage`，下次启动自动恢复 |

信号链（两端都是立体声）：

```
input → preGain → 左右分离 → 10 段 EQ（每声道独立）→ 平衡增益 → merger
      → M/S 分解 → 宽度 / 虚拟中置 / 环绕 / 高度 四路渲染 → 限幅器 → destination
```

细节与参数推导见 [`docs/soundfield-design.md`](docs/soundfield-design.md)。

## 3. 构建

环境：JDK 17、Android SDK（compileSdk 34 / build-tools 34.0.0）、Node.js 18+。

```bash
# 1. 安装依赖
npm install

# 2. 同步 Web 资源到 Android 工程
npx cap sync android

# 3. 构建 APK
cd android
echo "sdk.dir=$ANDROID_HOME" > local.properties
./gradlew assembleDebug
# 产物：android/app/build/outputs/apk/debug/app-debug.apk
```

正式包自签：

```bash
keytool -genkeypair -v -keystore mineradio-soundfield.jks -alias mineradio \
        -keyalg RSA -keysize 2048 -validity 10000
./gradlew assembleRelease   # 需在 android/app/build.gradle 里配 signingConfigs
```

> 官方包与本包的签名不同，**不能覆盖安装**，需先卸载官方版（会丢官方版的本地设置）。

## 4. 目录结构

```
www/                         Mineradio 安卓版 Web 前端（来自官方 APK v2.2.0）
├── js/soundfield/           ★ 本仓库新增：声场模型 / DSP 引擎 / 控制面板
├── css/soundfield.css       ★ 本仓库新增：声场面板样式
├── js/android-shim/         前端自带的原生适配层（node shim / api router / bridge）
└── js/modules/              播放器业务模块（05-playback 里挂了声场链入口）
android/                     Capacitor 6 Android 工程
└── app/src/main/java/com/mineradio/soundfield/
    ├── MainActivity.java            应用入口、WebView 设置
    └── FoliaBridgePlugin.java       原生 OkHttp 网络桥（绕 CORS / 混合内容）
tests/soundfield-engine-test.js     声场引擎离线自检（假 AudioContext）
docs/                       设计文档
```

## 5. 与原版安卓包的差异（重要）

| 项 | 状态 |
| --- | --- |
| 播放、搜索、歌单、歌词、可视化 | 保留（前端资源原样） |
| 网络请求（酷狗/QQ/网易云/汽水/Spotify） | 保留，走 `FoliaBridge` 原生请求 |
| 本地音乐扫描、壁纸（MpkgWallpaper）、插件市场、系统工具 | **未实现**，对应入口会优雅降级（前端已做 `|| null` 判空） |
| 扫码登录 Cookie | 保存在原生进程内存，**重启应用后需重新登录** |
| 官方版升级通道 | 不适用，本包不跟随官方版本号 |

## 6. 已知限制

- 声场输出最终仍是立体声。车机若通过 HAL 自行上混，实际听感会叠加一次车机处理，建议对照「2.0 纯直通」调参。
- HRTF 模式在低端车机上可能掉帧/爆音，默认使用等功率声像。
- 声场链只在播放器建立音频图时挂载；如果出现「拖滑杆没反应」，先确认正在播放（面板底部会显示挂载状态）。

## 7. 版权与许可

- 本项目代码以 **GPL-3.0** 发布，见 [LICENSE](LICENSE)。
- Mineradio 前端与品牌归原作者 **XxHuberrr** 所有（GPL-3.0）；本仓库是非官方衍生版，不代表原作者。
- 车型档案与声场预设口径来自 **FXPlayer / 声场 SoundField**（作者 licheng123qp）。
- 第三方库与素材的版权归各自作者，详见 [NOTICE.md](NOTICE.md)。

如果你喜欢 Mineradio，请去官网支持原作者：<https://mineradio.cn/>
