#!/usr/bin/env bash
# BioUnix Obsidian 插件发布脚本
#
# 用法:
#   ./scripts/release.sh <version>       # 构建并组装 release/ 目录
#   ./scripts/release.sh <version> --upload  # 同时上传到 GitHub Release（需 gh CLI）
#
# 说明:
#   Obsidian 插件 release 附件必须包含 manifest.json 引用的所有文件，
#   尤其是 icon.png —— 否则用户下载安装后图标会丢失。
#   本脚本自动构建并把 icon.png 一并复制到 release/ 目录，
#   --upload 时会上传 main.js / manifest.json / styles.css / icon.png 全部 4 个文件。

set -euo pipefail

if [[ $# -lt 1 ]]; then
    echo "Usage: $0 <version> [--upload]"
    echo "  version:  与 manifest.json 中一致的版本号，如 1.1.3"
    echo "  --upload: 构建后上传到 GitHub Release（需 gh CLI 已登录）"
    exit 1
fi

VERSION="$1"
UPLOAD=false
[[ "${2:-}" == "--upload" ]] && UPLOAD=true

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "==> 构建 (npm run build)"
npm run build

# 组装 release 目录 —— 必须包含 icon.png
echo "==> 组装 release/ 目录"
rm -rf release
mkdir -p release

cp dist/main.js       release/main.js
cp manifest.json      release/manifest.json
cp styles.css         release/styles.css
# ★ 关键：图标必须随 release 一起分发，否则用户安装后图标缺失
cp icon.png           release/icon.png

echo "==> release/ 目录内容:"
ls -la release/

# Validate: manifest icon reference exists in release/
# Supports both "icon" and "iconUrl" fields
ICON_FIELD=$(grep -o '"iconUrl"[[:space:]]*:[[:space:]]*"[^"]*"' release/manifest.json 2>/dev/null | sed 's/.*"iconUrl"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/' || true)
if [[ -z "$ICON_FIELD" ]]; then
    ICON_FIELD=$(grep -o '"icon"[[:space:]]*:[[:space:]]*"[^"]*"' release/manifest.json 2>/dev/null | sed 's/.*"icon"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/' || true)
fi
# Validate: manifest icon reference exists in release/
# Supports both "icon" and "iconUrl" fields
ICON_FIELD=$(grep -o '"iconUrl"[[:space:]]*:[[:space:]]*"[^"]*"' release/manifest.json 2>/dev/null | sed 's/.*"iconUrl"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/' || true)
if [[ -z "$ICON_FIELD" ]]; then
    ICON_FIELD=$(grep -o '"icon"[[:space:]]*:[[:space:]]*"[^"]*"' release/manifest.json 2>/dev/null | sed 's/.*"icon"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/' || true)
fi
if [[ -n "$ICON_FIELD" ]]; then
    # Remote URL: skip local check (icon.png already copied to release/)
    if [[ "$ICON_FIELD" == http* ]]; then
        echo "ok: icon is remote URL: $ICON_FIELD (icon.png bundled in release/)"
    elif [[ ! -f "release/$ICON_FIELD" ]]; then
        echo "ERROR: manifest.json references icon \"$ICON_FIELD\" but file not in release/"
        exit 1
    else
        echo "ok: icon verified: release/$ICON_FIELD"
    fi
fi

if [[ "$UPLOAD" == "true" ]]; then
    if ! command -v gh >/dev/null 2>&1; then
        echo "✗ 未找到 gh CLI，请先安装并登录: brew install gh && gh auth login"
        exit 1
    fi

    echo "==> 上传到 GitHub Release v$VERSION"
    # 若该 tag 的 release 已存在则上传资产到现有 release；否则新建
    if gh release view "$VERSION" --repo yukaiquan/obsidian-biounix >/dev/null 2>&1; then
        echo "   release $VERSION 已存在，上传资产..."
        gh release upload "$VERSION" \
            release/main.js release/manifest.json release/styles.css release/icon.png \
            --repo yukaiquan/obsidian-biounix --clobber
    else
        echo "   创建新 release $VERSION..."
        gh release create "$VERSION" \
            release/main.js release/manifest.json release/styles.css release/icon.png \
            --repo yukaiquan/obsidian-biounix \
            --title "BioUnix Obsidian Plugin v$VERSION" \
            --notes "Release v$VERSION"
    fi
    echo "✓ 发布完成: https://github.com/yukaiquan/obsidian-biounix/releases/tag/$VERSION"
else
    echo "==> 未传 --upload，仅构建。确认无误后运行:"
    echo "    ./scripts/release.sh $VERSION --upload"
fi
