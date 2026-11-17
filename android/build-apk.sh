#!/usr/bin/env bash
# 构建 Deepsleep APK：先递增版本号，再打包并签名，最后导出到 release/。
#
#   ./build-apk.sh              # 出包 → release/Deepsleep-<ver>.apk
#   ./build-apk.sh --dry-run    # 只打印将要做什么：不改版本文件、不同步 assets、不构建
#
# applicationId 只有一个（com.deepsleep.app），所以版本号也只有一条流：
# 实验版是同一身份的另一个构建，直接覆盖安装即可，会话与设置天然继承。
set -euo pipefail
cd "$(dirname "$0")"

DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --dry-run|-n)     DRY_RUN=1 ;;
    -h|--help)        sed -n '2,9p' "$0"; exit 0 ;;
    *) echo "用法: $0 [--dry-run]" >&2; exit 2 ;;
  esac
done

# 工具链：优先用环境变量；没设就假设装在系统默认位置（发行版包管理装出来的样子）。
# 本机原来的 /home/ubuntu/... 绝对路径已去掉——换机器就签不了，且不该进仓库。
export JAVA_HOME="${DEEPSLEEP_JDK:-${JAVA_HOME:-/usr/lib/jvm/java-17-openjdk-amd64}}"
export ANDROID_HOME="${DEEPSLEEP_SDK:-${ANDROID_HOME:-$HOME/android-sdk}}"
export ANDROID_SDK_ROOT="$ANDROID_HOME"
# 优先用仓库自带的 wrapper（版本与 CI 一致），没有再退回环境变量 / 系统安装
if [ -n "${DEEPSLEEP_GRADLE:-}" ]; then
  GRADLE="$DEEPSLEEP_GRADLE"
elif [ -x ./gradlew ]; then
  GRADLE=./gradlew
else
  GRADLE="$HOME/gradle-8.7/bin/gradle"
fi
APKSIGNER="$ANDROID_HOME/build-tools/34.0.0/apksigner"
AAPT2="$ANDROID_HOME/build-tools/34.0.0/aapt2"
DIST="$(cd "$(dirname "$0")/.." && pwd)/frontend/dist"
RELEASE_DIR="$(cd "$(dirname "$0")/.." && pwd)/release"
PROPS=version.properties

# 1) 版本号 +1：versionCode +1；versionName 补丁位 +1，满 9 进一位
#    （1.0.9 → 1.1.0，1.9.9 → 2.0.0）。先加号再打包：包里的号 = 文件里的号。
CODE=$(sed -n 's/^versionCode=\([0-9][0-9]*\).*/\1/p' "$PROPS" | head -n1)
NAME=$(sed -n 's/^versionName=\([0-9][0-9.]*\).*/\1/p' "$PROPS" | head -n1)
if [ -z "$CODE" ] || [ -z "$NAME" ]; then
  echo "版本文件缺 versionCode/versionName：$PROPS" >&2
  exit 1
fi
NEW=$((CODE + 1))
IFS='.' read -r MAJOR MINOR PATCH <<< "$NAME"
PATCH=${PATCH:-0}
MINOR=${MINOR:-0}
MAJOR=${MAJOR:-1}
# 补丁位直接 +1（不再满 9 进一：那会把 1.2.9 滚成 1.3.0）
PATCH=$((PATCH + 1))
NEWNAME="${MAJOR}.${MINOR}.${PATCH}"
if [ "$DRY_RUN" -eq 1 ]; then
  echo "[dry-run] 版本：$NAME → $NEWNAME (versionCode $CODE → $NEW)，写入 $PROPS"
else
  # 失败回滚用：先把原文件留一份
  cp "$PROPS" "$PROPS.bak"
  sed -i "s/^versionCode=.*/versionCode=$NEW/" "$PROPS"
  sed -i "s/^versionName=.*/versionName=$NEWNAME/" "$PROPS"
  echo "版本：$NAME → $NEWNAME (versionCode $CODE → $NEW)"
fi

# 2) 同步最新前端产物（assets/web 是构建期生成的，真源永远是 frontend/dist）
if [ "$DRY_RUN" -eq 1 ]; then
  echo "[dry-run] 同步 $DIST → app/src/main/assets/web"
else
  rm -rf app/src/main/assets/web
  mkdir -p app/src/main/assets/web
  cp -r "$DIST"/* app/src/main/assets/web/
fi

# 3) 构建（签名密钥路径在没有 -P 传入时用 build.gradle.kts 里的默认值）
if [ "$DRY_RUN" -eq 1 ]; then
  echo "[dry-run] $GRADLE --no-daemon --console=plain :app:assembleRelease"
  echo "[dry-run] 期望产物 app/build/outputs/apk/release/app-release.apk → $RELEASE_DIR/Deepsleep-$NEWNAME.apk"
  exit 0
fi
if ! "$GRADLE" --no-daemon --console=plain :app:assembleRelease; then
  mv "$PROPS.bak" "$PROPS"
  echo "构建失败，版本号已回滚到 $NAME" >&2
  exit 1
fi

# 4) 导出（失败同样回滚版本号：号是给能装上的包用的）
mkdir -p "$RELEASE_DIR"
OUT="$RELEASE_DIR/Deepsleep-$NEWNAME.apk"
if ! cp app/build/outputs/apk/release/app-release.apk "$OUT" || ! "$APKSIGNER" verify "$OUT" >/dev/null; then
  rm -f "$OUT"
  mv "$PROPS.bak" "$PROPS"
  echo "导出或签名校验失败，版本号已回滚到 $NAME" >&2
  exit 1
fi
rm -f "$PROPS.bak"

# 5) 顺手核对包身份，别把包名或 label 弄串了
"$AAPT2" dump badging "$OUT" | grep -E '^(package|application-label):' || true
echo "已生成 $OUT ($(du -h "$OUT" | cut -f1))"
