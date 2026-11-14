#!/usr/bin/env bash
set -euo pipefail
uuid=quick-chat@lbg2002.github.io
gnome-extensions disable "$uuid" 2>/dev/null || true
rm -rf -- "${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions/$uuid"
echo '已移除扩展。Pi 会话与配置保留；若需删除会话，请手动移除 ~/.local/share/gnome-quick-chat。'
