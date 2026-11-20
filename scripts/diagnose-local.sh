#!/usr/bin/env bash
# Read-only, secret-free local diagnostics. Does not read conversations, API keys,
# model provider configs or raw GNOME Shell logs.
set -u

uuid='quick-chat@lbg2002.github.io'
echo 'Quick Chat · 随问 本机只读诊断'
echo '================================'
printf '系统: '
uname -srm
if command -v gnome-shell >/dev/null 2>&1; then
  gnome-shell --version 2>/dev/null || echo 'GNOME Shell 版本无法读取'
else
  echo '未检测到 gnome-shell 命令'
fi
printf '桌面类型: %s\n' "${XDG_SESSION_TYPE:-unknown}"
echo '桌面会话环境（仅显示是否存在，不显示敏感变量值）:'
for name in DISPLAY WAYLAND_DISPLAY DBUS_SESSION_BUS_ADDRESS XDG_RUNTIME_DIR; do
  if [[ -n "${!name:-}" ]]; then
    printf '  %-28s 可用\n' "$name"
  else
    printf '  %-28s 未设置\n' "$name"
  fi
done
if command -v gnome-extensions >/dev/null 2>&1; then
  echo '扩展状态:'
  gnome-extensions info "$uuid" 2>/dev/null |
    grep -E '^(Name|UUID|State|Version|Shell-version):' || echo '未能读取扩展状态（可能需要登录桌面）'
else
  echo '扩展状态: 未安装 gnome-extensions 命令'
fi

for engine in zcode codex dsh; do
  echo
  echo "CLI: $engine"
  if command -v "$engine" >/dev/null 2>&1; then
    printf '路径: '
    command -v "$engine"
    printf '版本: '
    # Version output only. Do not print environment, API tokens, prompts,
    # CLI help, global configuration, or GNOME Shell journals.
    if command -v timeout >/dev/null 2>&1; then
      timeout 4 "$engine" --version 2>/dev/null | head -n 1 | cut -c 1-160 || echo '探测失败'
    else
      echo '缺少 timeout，跳过可能卡住的版本探测'
    fi
    if [[ "$engine" == dsh ]] && command -v timeout >/dev/null 2>&1; then
      if timeout 6 "$engine" --profile headless --help 2>/dev/null | grep -q -- '--permission-mode'; then
        echo 'Headless JSONL 权限接口：帮助中已检测到'
      else
        echo 'Headless 接口：未验证（请在随问诊断中检查 CLI 版本或配置档）'
      fi
    fi
  else
    echo 'PATH 中未找到该命令（如使用自定义路径，请在扩展设置中核查）'
  fi
done

echo
echo '注意：此脚本不会连接模型或验证 ZCode/Codex/DSH 的真实登录与权限审批。'
echo '请在随问中分别进行一次纯问答和一次只读任务，再检查界面内的脱敏诊断信息。'
echo '请勿直接公开包含 API Key、提示词或文件正文的原始日志。'
