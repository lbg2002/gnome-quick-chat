#!/usr/bin/env bash
set -euo pipefail

uuid="quick-chat@lbg2002.github.io"
purge=false

for arg in "$@"; do
  case "$arg" in
    --purge)
      purge=true
      ;;
    -h|--help)
      echo "用法: ./uninstall.sh [--purge]"
      echo "  默认仅卸载扩展文件并保留本地历史会话；"
      echo "  指定 --purge 将同时清理会话数据目录、运行时临时目录与系统密钥环中的 API Key。"
      exit 0
      ;;
    *)
      echo "未知参数: $arg（使用 --help 查看说明）" >&2
      exit 1
      ;;
  esac
done

if command -v gnome-extensions >/dev/null; then
  gnome-extensions disable "$uuid" 2>/dev/null || true
fi

rm -rf -- "${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions/$uuid"

if [[ "$purge" == true ]]; then
  rm -rf -- "${XDG_DATA_HOME:-$HOME/.local/share}/gnome-quick-chat"
  if [[ -n "${XDG_RUNTIME_DIR:-}" ]]; then
    rm -rf -- "$XDG_RUNTIME_DIR/gnome-quick-chat"
  fi
  if command -v secret-tool >/dev/null; then
    secret-tool clear account openai-compatible-api-key 2>/dev/null || true
  fi
  echo "✓ 已卸载扩展并彻底清理本地会话、临时文件与保存的密钥。"
else
  echo "✓ 已移除扩展文件。历史会话仍保留在 ~/.local/share/gnome-quick-chat（如需彻底清理请运行 ./uninstall.sh --purge）。"
fi
