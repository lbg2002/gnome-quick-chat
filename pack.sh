#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"

out_dir="${1:-dist}"
mkdir -p "$out_dir"

command -v gnome-extensions >/dev/null || {
  echo "错误：缺少 gnome-extensions 工具，无法执行标准打包" >&2
  exit 1
}
command -v glib-compile-schemas >/dev/null || {
  echo "错误：缺少 glib-compile-schemas" >&2
  exit 1
}

glib-compile-schemas --strict schemas

gnome-extensions pack . \
  --force \
  --out-dir="$out_dir" \
  --extra-source=piClient.js \
  --extra-source=protocol.js \
  --extra-source=zcodeBridge.cjs \
  --extra-source=core \
  --extra-source=ui

echo "✓ 扩展标准安装包已生成至：$out_dir/quick-chat@lbg2002.github.io.shell-extension.zip"
