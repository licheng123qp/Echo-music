# NOTICE

本仓库是 Mineradio 的第三方衍生版（非官方），按 GPL-3.0 发布。以下内容版权归各自作者所有。

## 上游项目

- **Mineradio** —— 作者 [XxHuberrr](https://github.com/XxHuberrr)，官网 <https://mineradio.cn/>，仓库 <https://github.com/XxHuberrr/Mineradio-paused>，许可 GPL-3.0。
  本仓库的 `www/` 目录来自其官方 Android 发行包（v2.2.0）中的 Web 资源，
  包含 `js/android-shim/`、`js/ported/`、`folia-visualizer/` 等模块。
- **FXPlayer / 声场 SoundField** —— 作者 licheng123qp，私有仓库 `licheng123qp/FXPlayer`。
  本仓库的车型目录、布局定义与声场预设口径（`www/js/soundfield/00-vehicle-model.js`）
  移植自该工程的 `audio-model` 模块，并按 Web 端能力做了裁剪与改写。

## 第三方库（随 Web 前端分发）

- Three.js（MIT）
- GSAP（标准许可，见 `www/vendor/`）
- music-tempo（MIT）
- qrcode（MIT，`www/js/android-shim/qrcode-core.js`）
- music-metadata（MIT，`www/js/android-shim/media-tags.js`）

## 第三方库（Android 工程）

- Capacitor 6（MIT）
- OkHttp 4（Apache-2.0）
- AndroidX（Apache-2.0）

## 声明

- 本项目与领克（Lynk & Co）、吉利、哈曼卡顿无任何隶属或授权关系；车型名称仅用于描述声场参数。
- 本项目不包含官方安装包、不提供任何音乐内容，所有在线内容均来自用户自行登录的第三方平台账号。
