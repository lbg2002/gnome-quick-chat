#!/usr/bin/env bash
# Read-only GNOME Shell performance sampler; no model prompts, tokens, logs,
# file contents, or process command-lines are collected.
set -euo pipefail

samples="${1:-30}"
if [[ ! "$samples" =~ ^[0-9]+$ ]] || ((samples < 1 || samples > 600)); then
  echo '用法: bash scripts/measure-shell.sh [采样秒数 1..600]' >&2
  exit 2
fi
pid="$(pgrep -u "$(id -u)" -x gnome-shell | head -n 1 || true)"
if [[ -z "$pid" ]]; then
  echo '未检测到当前用户的 gnome-shell 进程，请在 GNOME 桌面会话中运行' >&2
  exit 1
fi
echo "# GNOME Shell pid=$pid, interval=1s, samples=$samples"
echo '# 不包含模型或 Agent 子进程数据；建议分别测量禁用扩展、启用空闲、面板打开、流式回答'
if command -v pidstat >/dev/null 2>&1; then
  echo '# pidstat: 进程 CPU 使用率（周期采样），RSS 需结合 ps 单独查看'
  pidstat -u -r -p "$pid" 1 "$samples"
else
  echo 'timestamp_local,pid,cpu_percent_process_lifetime,rss_kib'
  echo '# 注意：ps %CPU 是进程生存期平均值，不是每秒瞬时 CPU；建议安装 sysstat 使用 pidstat' >&2
  for ((i=0; i<samples; i++)); do
    if ! kill -0 "$pid" 2>/dev/null; then
      echo '# gnome-shell 已退出，停止采样' >&2
      exit 1
    fi
    sample="$(ps -p "$pid" -o pid=,pcpu=,rss= 2>/dev/null | awk '{print $1","$2","$3}')"
    printf '%s,%s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$sample"
    sleep 1
  done
fi
