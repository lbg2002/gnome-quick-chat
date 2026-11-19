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
prior_enabled_state="unknown"
activation_confirmed=false

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
      if [[ "$prior_enabled_state" == "enabled" ]] && command -v gnome-extensions >/dev/null; then
        gnome-extensions enable "$uuid" >/dev/null 2>&1 || true
      fi
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
  backends/dshAdapter.js \
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

# 3. Preserve the extension's prior enable state. Never turn a disabled
# extension on merely because the user upgraded its files.
was_upgrade=false
if [[ -d "$dest" ]]; then
  was_upgrade=true
  if command -v gnome-extensions >/dev/null; then
    previous_info=$(gnome-extensions info "$uuid" 2>/dev/null || true)
    if [[ "$previous_info" =~ State:[[:space:]]*(ACTIVE|ENABLED) ]]; then
      prior_enabled_state="enabled"
      gnome-extensions disable "$uuid" 2>/dev/null || true
    elif [[ "$previous_info" =~ State:[[:space:]]*(INACTIVE|DISABLED) ]]; then
      prior_enabled_state="disabled"
    fi
  fi
  rm -rf -- "$backup"
  mv -- "$dest" "$backup"
fi

mv -- "$staging" "$dest"

[[ -f "$dest/extension.js" && -f "$dest/schemas/gschemas.compiled" ]] || {
  echo "错误：目标目录交换校验未通过：$dest" >&2
  exit 1
}

# 4. Verify activation BEFORE discarding the rollback copy.
# On Wayland the shell may only discover/reload modules after a new login;
# distinguish "activation deferred" from "confirmed working" rather than
# claiming success for code which has never been loaded.
enable_note="已安装文件；未验证 GNOME Shell 激活（重新登录后请检查扩展状态）"
if [[ "$was_upgrade" == true && "$prior_enabled_state" == "disabled" ]]; then
  activation_confirmed=true
  enable_note="已升级并保持原有禁用状态（如需启用请手动启用扩展）"
elif command -v gnome-extensions >/dev/null; then
  if gnome-extensions enable "$uuid" >/dev/null 2>&1; then
    ext_info=$(gnome-extensions info "$uuid" 2>/dev/null || true)
    if [[ "$ext_info" =~ State:[[:space:]]*(ACTIVE|ENABLED) ]]; then
      activation_confirmed=true
      if [[ "$was_upgrade" == true ]]; then
        enable_note="已请求启用（Shell 报告 ACTIVE/ENABLED；Wayland 下需要重新登录以确保新 JS 生效）"
      else
        enable_note="已成功启用（Shell 报告 ACTIVE/ENABLED）"
      fi
    elif [[ "$ext_info" =~ State:[[:space:]]*(ERROR|OUT_OF_DATE) ]]; then
      echo "错误：GNOME Shell 拒绝激活更新后的扩展：${BASH_REMATCH[1]}" >&2
      exit 1
    else
      enable_note="已请求启用，但尚未确认新版本已加载；Wayland 请注销并重新登录后检查"
    fi
  else
    if gnome-extensions info "$uuid" >/dev/null 2>&1; then
      echo "错误：GNOME Shell 可访问，但启用扩展失败；将回滚文件安装" >&2
      exit 1
    fi
    enable_note="当前终端未连接可用 GNOME Shell 会话；安装完成但尚未启用，重新登录后请手动启用"
  fi
fi

swap_committed=true
if [[ "$activation_confirmed" == true ]]; then
  [[ ! -d "$backup" ]] || rm -rf -- "$backup"
elif [[ -d "$backup" ]]; then
  echo "⚠️ 新版尚未确认加载，保留旧版回滚副本：$backup" >&2
  echo "   验证后可手动清理；需要回滚时先禁用扩展，再将备份目录恢复为 $dest" >&2
fi

echo "✓ 安装完成：$dest"
echo "启用状态：$enable_note"
echo "快捷键：Super+Shift+Q 呼出/收起随问，Super+Shift+Y 剪贴板随问"
echo "打开设置：gnome-extensions prefs $uuid"
