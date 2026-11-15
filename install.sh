#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"

uuid="quick-chat@lbg2002.github.io"
ext_root="${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions"
dest="$ext_root/$uuid"
staging="${dest}.staging.$$"
backup="${dest}.backup.$$"
lock_file="${ext_root}/.quick-chat-install.lock"
swap_committed=false

cleanup_and_rollback() {
  local exit_code=$?
  if [[ -d "$staging" ]]; then
    rm -rf -- "$staging" 2>/dev/null || true
  fi
  if [[ "$swap_committed" != true && -d "$backup" ]]; then
    if [[ -e "$dest" ]]; then
      rm -rf -- "$dest" 2>/dev/null || true
    fi
    if mv -- "$backup" "$dest" 2>/dev/null; then
      echo "⚠️ 安装未完成，已自动回滚至先前扩展版本：$dest" >&2
    else
      echo "❌ 安装失败且回滚备份失败，备份目录保留在：$backup" >&2
    fi
  fi
  exit "$exit_code"
}
trap cleanup_and_rollback EXIT

# 1. Dependency & Environment Checks
command -v glib-compile-schemas >/dev/null || {
  echo "错误：缺少 glib-compile-schemas（Ubuntu 请执行: sudo apt install libglib2.0-bin）" >&2
  exit 1
}
command -v gjs >/dev/null || {
  echo "错误：缺少 gjs 运行时（Ubuntu 请执行: sudo apt install gjs）" >&2
  exit 1
}
gjs -c "imports.gi.versions.Soup = '3.0'; const _ = imports.gi.Soup;" >/dev/null 2>&1 || {
  echo "错误：缺少 Soup 3.0 GObject Introspection 绑定（Ubuntu 请执行: sudo apt install gir1.2-soup-3.0）" >&2
  exit 1
}

if command -v gnome-shell >/dev/null; then
  version=$(gnome-shell --version)
  [[ "$version" =~ [[:space:]]50([.]|$) ]] || {
    echo "错误：当前扩展针对 GNOME Shell 50 构建，检测到版本：$version" >&2
    exit 1
  }
fi

mkdir -p "$ext_root"

# Acquire an exclusive per-extension install lock so concurrent installs cannot collide
if command -v flock >/dev/null; then
  exec 9>"$lock_file"
  flock -n 9 || {
    echo "错误：检测到另一个随问安装进程正在运行（锁文件：$lock_file）" >&2
    exit 1
  }
fi

# 2. Same-Filesystem Staging Build, Manifest Verification & Strict Schema Compilation
mkdir -p \
  "$staging/backends" \
  "$staging/core" \
  "$staging/runtime" \
  "$staging/ui" \
  "$staging/schemas"

install -m 644 \
  metadata.json \
  extension.js \
  backendClient.js \
  protocol.js \
  prefs.js \
  zcodeBridge.cjs \
  stylesheet.css \
  "$staging/"
install -m 644 backends/*.js "$staging/backends/"
install -m 644 core/*.js "$staging/core/"
install -m 644 runtime/*.js "$staging/runtime/"
install -m 644 ui/*.js "$staging/ui/"
install -m 644 schemas/*.xml "$staging/schemas/"

glib-compile-schemas --strict "$staging/schemas"

for req in \
  metadata.json \
  extension.js \
  backendClient.js \
  protocol.js \
  prefs.js \
  zcodeBridge.cjs \
  stylesheet.css \
  schemas/gschemas.compiled \
  backends/baseAdapter.js \
  backends/zcodeAdapter.js \
  backends/codexAdapter.js \
  backends/openaiAdapter.js \
  core/backendRegistry.js \
  core/chatController.js \
  runtime/processManager.js \
  ui/chatPanel.js \
  ui/dateMenuIntegration.js
do
  [[ -f "$staging/$req" ]] || {
    echo "错误：暂存包缺失必需文件：$req" >&2
    exit 1
  }
done

# 3. Disable Only This Extension (if already installed), Backup Previous Version & Swap with Rollback
was_upgrade=false
if [[ -d "$dest" ]]; then
  was_upgrade=true
  if command -v gnome-extensions >/dev/null; then
    gnome-extensions disable "$uuid" 2>/dev/null || true
  fi
  rm -rf -- "$backup"
  mv -- "$dest" "$backup"
fi

mv -- "$staging" "$dest"

# Post-swap sanity verification before committing and discarding backup
[[ -f "$dest/extension.js" && -f "$dest/schemas/gschemas.compiled" ]] || {
  echo "错误：目标目录交换校验未通过：$dest" >&2
  exit 1
}

swap_committed=true
if [[ -d "$backup" ]]; then
  rm -rf -- "$backup"
fi

# 4. Enable ONLY This Extension & Report Actual Activation Result
enable_note="未检测到 gnome-extensions 命令；登录 GNOME 桌面后请执行: gnome-extensions enable $uuid"
if command -v gnome-extensions >/dev/null; then
  if gnome-extensions enable "$uuid" >/dev/null 2>&1; then
    ext_info=$(gnome-extensions info "$uuid" 2>/dev/null || true)
    if [[ "$ext_info" =~ State:[[:space:]]*(ACTIVE|ENABLED) ]]; then
      if [[ "$was_upgrade" == true ]]; then
        enable_note="已请求启用（当前状态：ACTIVE/ENABLED；Wayland 下更新已加载扩展的 JS 模块需重新登录桌面后完全生效）"
      else
        enable_note="已成功启用（当前状态：ACTIVE/ENABLED）"
      fi
    elif [[ "$ext_info" =~ State:[[:space:]]*([A-Z_]+) ]]; then
      enable_note="已写入启用请求（当前状态：${BASH_REMATCH[1]}；Wayland 首次发现新扩展通常需重新登录桌面后生效）"
    else
      enable_note="已请求启用 $uuid（Wayland 会话下首次安装或更新扩展建议重新登录桌面生效）"
    fi
  else
    enable_note="当前终端未连接活动 GNOME Shell 会话，进入桌面后请执行: gnome-extensions enable $uuid"
  fi
fi

echo "✓ 安装完成：$dest"
echo "启用状态：$enable_note"
echo "快捷键：Super+Shift+Q 呼出/收起随问，Super+Shift+Y 剪贴板随问"
echo "打开设置：gnome-extensions prefs $uuid"
