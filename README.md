# Mineradio 声场版（仓库：Echo music）

> 基于 [Mineradio](https://github.com/XxHuberrr/Mineradio-paused) 安卓版前端重建的 **Android 工程**，并加入**领克 08 声场控制**：车型匹配、7.1.4 虚拟声场、左右/前后平衡、声场宽度、虚拟中置、10 段 EQ。
>
> **本项目是第三方衍生版，不是 Mineradio 官方版本。** 原项目版权归 [XxHuberrr](https://github.com/XxHuberrr) 所有，按 GPL-3.0 授权。
>
> 仓库：<https://github.com/licheng123qp/Echo-music> · 应用名：**Mineradio 声场版** · 包名：`com.mineradio.soundfield`

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

## 3. 分辨率适配（领克 08 车机 2560×1600 16:10）

车机中控是 **2560×1600 横屏**，而 Mineradio 的 `index.html` 会把布局视口放大到「屏宽 / 0.38」再用
`initial-scale=0.38` 缩回，实测在 WebView 里：

| 指标 | 实测值 |
| --- | --- |
| 布局视口宽（`clientWidth`） | 5858（缩放 115% 时；上游 0.38 缩放下会一路涨到 Chrome 上限 10000） |
| `visualViewport.scale` | **0.437**（= 0.38 × 1.15） |
| 肉眼可见区域 | 2560 × 1600 |

整体比例由 `index.html` 里的 `BASE_SCALE = 0.38` 乘一个可调倍率决定，默认**车机 115%、手机 100%**，
面板里可以切 100% / 115% / 130% / 150% / 200%（200% 时布局宽 3368，面板 1177×1397，仍在屏内）。

也就是说 **`vw/vh` 是按 10000 算的，比可见区域大 2.6~9.7 倍**；`position: fixed` 的百分比同样按布局视口算。
所以常见的 `width: 80vw; left: 50%` 写法在这个页面里会把面板放大并推到屏幕外。

本项目的做法：

1. **按可见视口定位**：根节点用 `visualViewport.offset/width/height` 写到 inline style，面板内部用 `position: absolute` 相对根节点定位；
2. **视觉像素换算**：`--sf-k = 1 / visualViewport.scale`，CSS 里所有固定尺寸都写成 `calc(var(--sf-k) * Npx)`，保证 N 就是肉眼看到的像素数；
3. **触控尺寸随屏幕走**：`--sf-tap` 由 JS 按屏幕 CSS 宽度取 `clamp(36, 宽度×0.022, 56)`，`--sf-fs` 取 `clamp(15, 宽度×0.0078, 21)`；
4. **横屏抽屉**：可见视口宽高比 ≥ 1.45 时挂 `sf-drawer` 类，面板变成右侧抽屉（领克 08 的 16:10 会命中）；
5. **底部操作条不随内容滚动**：`恢复默认 / 状态` 固定在面板底部，滚到一半也能点。

实测结果（headless Chromium + CDP 设备模拟，`tests/cdp-layout-audit.js`）：

| 屏幕 | 布局 | 面板尺寸 | 预设按钮 | 滑杆触控高 | 越界 |
| --- | --- | --- | --- | --- | --- |
| 2560×1600（领克 08 车机，115%） | 右侧抽屉 | 692×1397 | 66×62 | 62 | 无 |
| 1920×720 | 右侧抽屉 | 601×629 | 50×41 | 41 | 无 |
| 1280×800 | 右侧抽屉 | 571×698 | 50×35 | 35 | 无 |
| 393×873（手机竖屏） | 居中卡片 | 351×745 | 50×35 | 35 | 无 |

> 复跑：`node tests/cdp-layout-audit.js http://127.0.0.1:8765/index.html 2560 1600 1`
> （需要先 `python3 -m http.server 8765` 起静态服务，并让 headless Chromium 监听 9222 端口）。

## 4. 性能：3D 粒子为什么吃 CPU，以及怎么改的

上游的 3D 舞台按 `innerWidth × innerHeight` 建 WebGL drawing buffer。问题在于本页面会把
布局视口放大（见上一节），车机上 `innerWidth` 是 5858~10000，而肉眼只有 2560 ——
等于把粒子渲染分辨率放大 3~4 倍：实测 drawing buffer 是 **5200×3250（1690 万像素）**，
是屏幕像素的 6.6 倍，中端车机 GPU 直接被拖死。

本项目的修法（`www/js/modules/01-scene/00-renderer-quality.js`）：

1. 新增 `renderSurfaceSize()`，用 `visualViewport.width × scale` 得到**屏幕 CSS 像素**（2560×1600）；
2. 像素预算、DPR 上限、drawing buffer 全部按这个尺寸算；
3. `renderer.setSize()` 用新尺寸且 `updateStyle=false`，canvas 的 CSS 尺寸不变，只改 buffer。

效果：

| 指标 | 上游 | 本项目 |
| --- | --- | --- |
| drawing buffer | 5200×3250（16.9M 像素） | **1959×1224（2.4M 像素）** |
| 相对屏幕过采样 | 6.6× | 0.96× |
| 默认帧率 | 跟随屏幕（通常 60） | **45 FPS**（面板可切 30/45/60/跟随） |

另外面板里提供「画质 低/中/高」与「帧率上限」两个开关，直接写上游的
`setPerformanceQualityMode` / `setForegroundFpsMode`，和原 fx 面板同一份持久化。
`30 FPS` 是本项目给 `normalizeForegroundFpsMode` 新增的档位（上游只支持 45 起）。

## 5. 粒子总开关（默认关闭）

车机上 3D 粒子是最大的持续开销：封面点阵 + 辉光各 33k 顶点、星空、骷髅/背板、歌词粒子、Sonic 地形，
叠加加法混合后基本是「满屏像素都在算」。本版**默认关闭全部粒子**，面板里可以随时切回。

实现方式（`www/js/soundfield/05-no-particles.js`，加载在 `index-loader` 之前）：

1. 包住 `THREE.Points` 构造函数，任何粒子对象创建时就被登记；
2. 锁住实例的 `visible`：上游主循环每帧都会重写 `particles.visible`，直接赋值会被覆盖，
   这里改成「写入照收、关闭态读出来恒为 false」，不影响上游逻辑但真的不画；
3. `geometry.setDrawRange(0, 0)`，即使将来被设为可见，GPU 也不遍历顶点；
4. 把 `updateSkullParticleLayer` / `updateFloatLayer` / `tickLyricsParticles` 以及
   `MineradioSonicTopography/Workshop.update` 包一层开关，关闭时连顶点属性都不计算；
5. 打开时原样恢复（保留上游最后一次写入的可见性）。

关闭粒子后，背景仍是 `#album-bg` 的模糊专辑底色，歌词/播放控制不受影响。
想恢复原视觉：面板「粒子效果 → 开」，或设置 `localStorage['mineradio-particles-enabled-v1']='1'`。

## 6. 启动与更新体验

- **去掉开屏「点击进入」**：`06-skip-splash.js` 在 `index-loader` 之前把
  `mineradio-startup-fast-skip-v1` 置 1，并在 DOM 就绪时主动 `dismissSplash({instant:true})`，
  开机直接进首页；顺带省掉开屏那段 WebGL 动画与开场音。
- **下载进度**：原生 `DownloadManager` 每 500ms 查一次 `已下载 / 总大小`，通过
  `notifyListeners('progress')` 推给前端，面板状态行与按钮实时显示百分比与 MB 进度。

## 7. 应用内检查更新

声场面板底部有「版本 · 检查更新」：

1. 通过 `https://api.github.com/repos/licheng123qp/Echo-music/releases/latest` 取最新 Release；
2. 用本机 `versionName`（原生 `PackageManager` 读取）和 tag 做语义化比较
   （`2.2.0-sf4` vs `2.2.0-sf3`：先比 2.2.0，再比 `sf` 后的数字；正式版 `2.3.0` 高于任何 `2.2.x-sfN`）；
3. 有新版本时出现「下载并安装 vX」按钮：原生 `DownloadManager` 下载到应用私有目录，
   完成广播后用 `FileProvider` 交给系统安装器（首次需要允许「安装未知应用」）；
4. 检查结果缓存 24 小时，避免把 GitHub 匿名 API 的 60 次/小时额度打满；
5. GitHub 在该车机网络下不可达时，按钮会变成「打开发布页面」，走系统浏览器兜底。

相关文件：

| 文件 | 职责 |
| --- | --- |
| `www/js/soundfield/30-update.js` | 版本比较、请求 GitHub、触发下载 |
| `android/.../MineradioUpdaterPlugin.java` | `getAppInfo` / `downloadAndInstall` / `install` / `openExternal` |
| `android/app/src/main/res/xml/file_paths.xml` | FileProvider 暴露下载目录 |
| `AndroidManifest.xml` | `REQUEST_INSTALL_PACKAGES` 权限 |

> 下载与安装只能在真机上验证；浏览器预览里点检查会显示「最新发布 vX；本机版本未知」。

## 8. 构建

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

## 9. 目录结构

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

## 10. 与原版安卓包的差异（重要）

| 项 | 状态 |
| --- | --- |
| 播放、搜索、歌单、歌词、可视化 | 保留（前端资源原样） |
| 网络请求（酷狗/QQ/网易云/汽水/Spotify） | 保留，走 `FoliaBridge` 原生请求 |
| 本地音乐扫描、壁纸（MpkgWallpaper）、插件市场、系统工具 | **未实现**，对应入口会优雅降级（前端已做 `|| null` 判空） |
| 扫码登录 Cookie | 保存在原生进程内存，**重启应用后需重新登录** |
| 官方版升级通道 | 不适用，本包不跟随官方版本号 |

## 11. 已知限制

- 声场输出最终仍是立体声。车机若通过 HAL 自行上混，实际听感会叠加一次车机处理，建议对照「2.0 纯直通」调参。
- HRTF 模式在低端车机上可能掉帧/爆音，默认使用等功率声像。
- 声场链只在播放器建立音频图时挂载；如果出现「拖滑杆没反应」，先确认正在播放（面板底部会显示挂载状态）。
- 面板强制按 `visualViewport` 布局，因此**不支持系统级「网页缩放」之外的手动捏合缩放**；车机上的 `maximum-scale=0.38` 也决定了这一点。

## 12. 版权与许可

- 本项目代码以 **GPL-3.0** 发布，见 [LICENSE](LICENSE)。
- Mineradio 前端与品牌归原作者 **XxHuberrr** 所有（GPL-3.0）；本仓库是非官方衍生版，不代表原作者。
- 车型档案与声场预设口径来自 **FXPlayer / 声场 SoundField**（作者 licheng123qp）。
- 第三方库与素材的版权归各自作者，详见 [NOTICE.md](NOTICE.md)。

如果你喜欢 Mineradio，请去官网支持原作者：<https://mineradio.cn/>
