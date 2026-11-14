#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
uuid=quick-chat@lbg2002.github.io
dest="${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions/$uuid"
command -v glib-compile-schemas >/dev/null || { echo '缺少 glib-compile-schemas（Ubuntu: sudo apt install libglib2.0-bin）'; exit 1; }
if command -v gnome-shell >/dev/null; then
  version=$(gnome-shell --version)
  [[ "$version" =~ [[:space:]]50[.] ]] || { echo "仅针对 GNOME Shell 50 开发，当前：$version"; exit 1; }
fi
if command -v gnome-extensions >/dev/null; then gnome-extensions disable "$uuid" 2>/dev/null || true; fi
mkdir -p "$dest/schemas"
install -m 644 metadata.json extension.js piClient.js protocol.js prefs.js zcodeBridge.cjs stylesheet.css "$dest/"
install -m 644 schemas/*.xml "$dest/schemas/"
glib-compile-schemas --strict "$dest/schemas"

# Pre-register UUID in gsettings enabled-extensions so it auto-enables on Wayland re-login
if command -v gsettings >/dev/null && command -v python3 >/dev/null; then
  python3 - "$uuid" << 'PY' || true
import ast, subprocess, sys
uuid = sys.argv[1]
try:
    raw = subprocess.check_output(['gsettings', 'get', 'org.gnome.shell', 'enabled-extensions'], text=True).strip()
    arr = [] if raw.startswith('@as') else list(ast.literal_eval(raw))
    if uuid not in arr:
        arr.append(uuid)
        subprocess.run(['gsettings', 'set', 'org.gnome.shell', 'enabled-extensions', repr(arr)], check=False)
    raw_dis = subprocess.check_output(['gsettings', 'get', 'org.gnome.shell', 'disabled-extensions'], text=True).strip()
    dis = [] if raw_dis.startswith('@as') else list(ast.literal_eval(raw_dis))
    if uuid in dis:
        dis.remove(uuid)
        subprocess.run(['gsettings', 'set', 'org.gnome.shell', 'disabled-extensions', repr(dis)], check=False)
except Exception:
    pass
PY
fi

if command -v gnome-extensions >/dev/null; then gnome-extensions enable "$uuid" 2>/dev/null || true; fi
echo "安装完成：$dest"
echo "已自动写入启用列表。Wayland 会话首次安装请注销并重新登录，之后点击屏幕顶部中间的「时间/日期」即可看到左侧「✦ 随问 | 通知」入口。"
echo "设置命令：gnome-extensions prefs $uuid"
