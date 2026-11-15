#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"

uuid="quick-chat@lbg2002.github.io"
ext_root="${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions"
dest="$ext_root/$uuid"
staging="${dest}.staging.$$"

cleanup_staging() {
  if [[ -d "$staging" ]]; then
    rm -rf -- "$staging"
  fi
}
trap cleanup_staging EXIT

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

# 2. Atomic Staging Build & Schema Validation
mkdir -p "$staging/core" "$staging/ui" "$staging/schemas"

install -m 644 metadata.json extension.js backendClient.js protocol.js prefs.js zcodeBridge.cjs stylesheet.css "$staging/"
install -m 644 core/*.js "$staging/core/"
install -m 644 ui/*.js "$staging/ui/"
install -m 644 schemas/*.xml "$staging/schemas/"

glib-compile-schemas --strict "$staging/schemas"

# 3. Disable Running Extension (ignore only if not yet installed) & Swap Atomically
if command -v gnome-extensions >/dev/null && [[ -d "$dest" ]]; then
  gnome-extensions disable "$uuid" 2>/dev/null || true
fi

mkdir -p "$ext_root"
rm -rf -- "$dest"
mv -- "$staging" "$dest"

# 4. Enable Extension & Pre-register for Wayland Session
if command -v gsettings >/dev/null && command -v python3 >/dev/null; then
  if ! python3 - "$uuid" << 'PY'
import ast, subprocess, sys
uuid = sys.argv[1]
raw = subprocess.check_output(['gsettings', 'get', 'org.gnome.shell', 'enabled-extensions'], text=True).strip()
arr = [] if raw.startswith('@as') else list(ast.literal_eval(raw))
if uuid not in arr:
    arr.append(uuid)
    subprocess.run(['gsettings', 'set', 'org.gnome.shell', 'enabled-extensions', repr(arr)], check=True)
raw_dis = subprocess.check_output(['gsettings', 'get', 'org.gnome.shell', 'disabled-extensions'], text=True).strip()
dis = [] if raw_dis.startswith('@as') else list(ast.literal_eval(raw_dis))
if uuid in dis:
    dis.remove(uuid)
    subprocess.run(['gsettings', 'set', 'org.gnome.shell', 'disabled-extensions', repr(dis)], check=True)
PY
  then
    echo "提示：未能通过 gsettings 自动预注册启用列表，请稍后手动执行 gnome-extensions enable $uuid" >&2
  fi
fi

if command -v gnome-extensions >/dev/null; then
  gnome-extensions enable "$uuid" 2>/dev/null || true
fi

echo "✓ 安装完成：$dest"
echo "快捷键：Super+Shift+Q 呼出/收起随问，Super+Shift+Y 剪贴板随问（Wayland 首次安装或更新扩展代码后请重新登录桌面生效）。"
echo "打开设置：gnome-extensions prefs $uuid"
