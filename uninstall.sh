#!/usr/bin/env bash
set -euo pipefail

uuid="quick-chat@lbg2002.github.io"
schema_id="org.gnome.shell.extensions.quick-chat"
purge=false

for arg in "$@"; do
  case "$arg" in
    --purge)
      purge=true
      ;;
    -h|--help)
      echo "用法: ./uninstall.sh [--purge]"
      echo "  默认仅卸载扩展文件并保留本地历史会话；"
      echo "  指定 --purge 将同时清理本扩展 GSettings、会话数据目录、运行时/缓存目录与本扩展专属系统密钥环项（绝不删除外部 CLI 原生数据）。"
      exit 0
      ;;
    *)
      echo "未知参数: $arg（使用 --help 查看说明）" >&2
      exit 1
      ;;
  esac
done

data_home="${XDG_DATA_HOME:-$HOME/.local/share}"
cache_home="${XDG_CACHE_HOME:-$HOME/.cache}"
ext_dir="$data_home/gnome-shell/extensions/$uuid"
app_data_dir="$data_home/gnome-quick-chat"
app_cache_dir="$cache_home/gnome-quick-chat"

if command -v gnome-extensions >/dev/null; then
  gnome-extensions disable "$uuid" 2>/dev/null || true
fi

purge_errors=0

remove_dir_checked() {
  local target="$1"
  local label="$2"
  if [[ ! -e "$target" && ! -L "$target" ]]; then
    return 0
  fi
  if ! rm -rf -- "$target"; then
    echo "错误：无法删除${label}：$target" >&2
    purge_errors=$((purge_errors + 1))
    return 1
  fi
  if [[ -e "$target" || -L "$target" ]]; then
    echo "错误：删除后仍残留${label}：$target" >&2
    purge_errors=$((purge_errors + 1))
    return 1
  fi
  return 0
}

# Reset extension GSettings BEFORE removing the extension directory so local compiled schema can be used
if [[ "$purge" == true ]] && command -v gsettings >/dev/null; then
  if [[ -f "$ext_dir/schemas/gschemas.compiled" ]]; then
    if ! gsettings --schemadir "$ext_dir/schemas" reset-recursively "$schema_id"; then
      echo "错误：清理扩展 GSettings 配置 ($schema_id) 失败" >&2
      purge_errors=$((purge_errors + 1))
    fi
  elif gsettings list-schemas 2>/dev/null | grep -Fxq "$schema_id"; then
    if ! gsettings reset-recursively "$schema_id"; then
      echo "错误：清理系统 GSettings 配置 ($schema_id) 失败" >&2
      purge_errors=$((purge_errors + 1))
    fi
  fi
fi

remove_dir_checked "$ext_dir" "扩展安装目录" || true

if [[ "$purge" == true ]]; then
  remove_dir_checked "$app_data_dir" "本地会话数据目录" || true
  if [[ -n "${XDG_RUNTIME_DIR:-}" ]]; then
    remove_dir_checked "$XDG_RUNTIME_DIR/gnome-quick-chat" "运行时临时目录" || true
  fi
  remove_dir_checked "$app_cache_dir" "缓存回退目录" || true

  if command -v secret-tool >/dev/null; then
    # Strictly scope Keyring deletion to Quick Chat's own libsecret schemas so other apps' credentials are never touched!
    if ! secret-tool clear \
      xdg:schema org.gnome.shell.extensions.quick-chat.endpoint-apikey \
      account openai-endpoint-api-key; then
      echo "错误：从系统密钥环清除随问端点 API Key 失败（请检查 GNOME Keyring 是否已解锁）" >&2
      purge_errors=$((purge_errors + 1))
    fi
    if ! secret-tool clear \
      xdg:schema org.gnome.shell.extensions.quick-chat.apikey \
      account openai-compatible-api-key; then
      echo "错误：从系统密钥环清除随问旧版 API Key 失败（请检查 GNOME Keyring 是否已解锁）" >&2
      purge_errors=$((purge_errors + 1))
    fi
  fi

  if (( purge_errors > 0 )); then
    echo "⚠️ 卸载清理过程中有 ${purge_errors} 项操作失败，请根据上方错误提示检查权限或密钥环状态。" >&2
    exit 1
  fi

  echo "✓ 已卸载扩展并彻底清理本扩展配置、本地会话、运行时/缓存目录与专属密钥环项。"
else
  if (( purge_errors > 0 )); then
    exit 1
  fi
  echo "✓ 已移除扩展文件。历史会话仍保留在 ~/.local/share/gnome-quick-chat（如需彻底清理请运行 ./uninstall.sh --purge）。"
fi
