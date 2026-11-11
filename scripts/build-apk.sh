#!/usr/bin/env bash
# scripts/build-apk.sh
# 一条命令构建 APK：同步 Web 资源 → 调 Gradle。
#
# 为什么单独写一个脚本：
#   Capacitor 的 www/ 必须先 cap sync 才会进到 android/app/src/main/assets/public，
#   直接 gradle assembleDebug 会打进上一次的旧资源，很难察觉；这里强制先同步。
#
# 用法：
#   ANDROID_HOME=/path/to/android-sdk ./scripts/build-apk.sh [debug|release]
#
# 注意：
#   · Gradle 的 debug 签名默认写到 $HOME/.android/debug.keystore；
#     如果 HOME 不可写（容器/群晖常见），脚本会把 user.home 指到 $GRADLE_USER_HOME。
#   · release 需要自己配 signingConfigs，脚本只负责调用 assembleRelease。

set -euo pipefail

MODE="${1:-debug}"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

# 1) 环境检查：缺 SDK 时给出可操作的提示，而不是让 Gradle 报一堆找不到 aapt2
if [[ -z "${ANDROID_HOME:-}" && -z "${ANDROID_SDK_ROOT:-}" ]]; then
  echo "错误：请先设置 ANDROID_HOME 或 ANDROID_SDK_ROOT" >&2
  exit 1
fi
export ANDROID_SDK_ROOT="${ANDROID_SDK_ROOT:-$ANDROID_HOME}"

if ! command -v node >/dev/null 2>&1; then
  echo "错误：需要 Node.js 18+ 来执行 cap sync" >&2
  exit 1
fi

# 2) 依赖与 Web 资源同步
if [[ ! -d node_modules/@capacitor/cli ]]; then
  npm install
fi
npx cap sync android

# 3) 写入 local.properties（Gradle 用它找 SDK）
echo "sdk.dir=${ANDROID_SDK_ROOT}" > android/local.properties

# 4) HOME 不可写时把 Java user.home 挪到 GRADLE_USER_HOME，否则 debug 签名初始化会失败
export GRADLE_USER_HOME="${GRADLE_USER_HOME:-$ROOT_DIR/.gradle-home}"
mkdir -p "$GRADLE_USER_HOME/.android"
export GRADLE_OPTS="${GRADLE_OPTS:-} -Duser.home=$GRADLE_USER_HOME"

# 5) 构建
TASK="assemble${MODE^}"
cd android
if [[ -x ./gradlew ]]; then
  ./gradlew "$TASK" --no-daemon
else
  gradle "$TASK" --no-daemon
fi

echo "构建完成：android/app/build/outputs/apk/${MODE}/"
