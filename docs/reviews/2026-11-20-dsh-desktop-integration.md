# DSH / ZCode 桌面控制专项修复与验收

> 2026-11-20 · Quick Chat v0.3.2 · 源码基线来自 `lbg2002/gnome-quick-chat` main 和 `deepseek-ai/deepseek-harness` master。本文描述**代码已实施内容和仍需实机验证的边界**，不是 GNOME 50 真机验收报告。

## 用户反馈与可确认根因

1. DSH 报 `DSH 未正常完成本次任务：error`：旧版 `protocol.js` 已能识别 `final.reason.kind`，但没有提取 `reason.error.code/message`；现在会显示真实提供方/沙箱错误细节。参考上游 [Headless 结算](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/bundle/headless/src/index.ts#L434-L441) 和 [JSONL 最终事件](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/bundle/headless/src/json-stream.ts#L320-L327)。Chrome 子进程显示 zygote pipe 错误，并不能独立证明 Chrome 或桌面没有正常打开，需结合原生错误和 `gio open` 状态核实。
2. DSH 无模型列表：Headless 不提供按模型枚举的 CLI。内置的 DeepSeek 官方模型分别为 `deepseek-flash`、`deepseek-v4-pro`（[官方目录](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/llm/llm-deepseek/src/models.ts)）；随问通过 `dsh --profile headless --dump-config` 只读获取当前 Provider 和模型，合并到本地 UI 目录。此处**不是**所有自定义 Provider 的完整在线模型列表，不承诺实际密钥和模型权限可用。
3. 桌面 Bash 沙箱：上游 Headless profile 自带 `sandbox-policy` 和 Bash sandbox。`--permission-mode danger-full-access` 走主机 Bash（[本地 Bash](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/shell/bash-local/README.md) 与 [沙箱说明](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/shell/bash-sandbox/README.md)），但不会自动变成 root，也不会忽略 Wayland/D-Bus/Chrome 自身安全机制。

## 已实现源码

- `protocol.js`：DSH 解析结构化 `final.reason.kind/error.code/message`；保留工具错误原因，不再吞掉真实失败码；`buildDshArgs` 支持官方 `--patch`，针对 `readonly/smart/full` 映射只读、显式实验 Auto、完全权限；无授权时默认保持只读。ZCode/Codex 首轮注入桌面助手指引，不将提示词当作沙箱。
- `core/dshModelCatalog.js`：纯逻辑解析模型配置（严格 ID 验证）、内置官方建议模型、本地脱敏目录、YAML 安全引用、内置 Ubuntu GNOME 中文桌面助手 persona。处理任意引号/换行而不允许 YAML 插入。
- `core/backendDetect.js`：异步限时、限字节的 `--dump-config` 探测；**只**缓存 Provider、Model 等合法 ID，不保留凭据、配置原始文本。
- `core/backendRegistry.js` / GSettings：DSH 独立 Provider/Model；用户可编辑桌面助手提示词；实验 Auto Review 开关默认关闭。
- `backends/dshAdapter.js`：官方 `headless` 任务输入使用标准 stdin；通过当前回合的私有临时 YAML `--patch` 配置 Provider/Model 和系统 persona，按进程退出清理；不会覆盖 `$DSH_HOME`。模型发现返回建议目录。完整权限只按显式用户设置开启。
- `prefs.js`：四后端中的 DSH 可选模型与自定义 ID、异步刷新、编辑多行桌面助手提示词、恢复默认；手动启用实验 Auto Review；无弹窗审批通道时不声称可以逐项审批。
- `scripts/diagnose-local.sh`：只报告桌面会话环境变量是否存在，不输出 Cookie、Token、Key 或变量值。
- `tests/dshAndPermissionModes.test.js` / `tests/gjs_smoke.js`：模型默认/覆盖、YAML 注入拒绝、错误细节、权限回退、DSH 真实 Gio 子进程读取补丁及消息结算等。

## DSH 权限选择

| 权限 | CLI 预设 | 能否启动真实系统应用 | 行为边界 |
| --- | --- | --- | --- |
| 只读 | `read-only` | **不承诺**（可能被沙箱拒绝） | 禁止文件写入 |
| 智能，默认 | `read-only` | **不承诺** | 未配置实验 Reviewer 时故障安全 |
| 智能，手动启用实验 Auto Review | `auto --approval-policy never` | 低风险可能获准 | 每个受支持工具调用先由模型审核，可能误判；高风险拒绝而非要求弹窗 |
| 完全权限，明确确认 | `danger-full-access --approval-policy never` | **允许使用主机 Bash 运行普通用户的应用** | 风险很高；不能提升到 root、不能禁用 Chrome 沙箱、不能绕开 Wayland |

实验模式需用户自行通过官方命令安装插件：

```bash
dsh plugin --profile headless add @deepseek-ai/dsh-experimental-auto-review
```

参考 [上游实验 Auto Review](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/experimental/auto-review/README.zh.md)。其前置模型审查并非可靠 OS 强制隔离，也无法保证危险操作不会误执行。

## 本机现场验证（截至报告创建：**blocked**）

1. 更新：`git pull --ff-only origin main && bash install.sh`，GNOME Wayland 下注销并重新登录；设置界面版本应为 `v0.3.2`。
2. 诊断：`bash scripts/diagnose-local.sh`；验证 `dsh --version`、`dsh --profile headless --help`、`dsh --profile headless --dump-config`。后者可能包含配置敏感信息，**不要公开原始输出**。
3. 只读：用 DSH 提问「只介绍你可用的工具和当前工作目录」，确认无模型认证错误；再要求只读查询文件。对话失败时把新版**脱敏错误码和阶段**提供给维护者。
4. 模型：检查默认 `deepseek-flash`、`deepseek-v4-pro` 及已有用户 profile Provider/Model；选择用户确有凭据的模型进行普通问答，切换模型后新会话也应使用新 ID。
5. 提示词：在「界面与权限」编辑、保存、重连并重开会话，测试 ZCode、Codex、DSH 是否采用中文桌面助手指引；恢复默认。
6. 真实桌面：仅在**已经明确确认可信任务并切换完全权限**后，先试 `gio open https://example.com` 或 `gtk-launch` 启动已经安装的普通应用；确认实际窗口存在。检测后台 GNOME Shell 是否具备 `DISPLAY/WAYLAND_DISPLAY/DBUS_SESSION_BUS_ADDRESS`。不得以 Chrome zygote 单条 stderr 错误判定整个任务失败。
7. 智能实验模式：只有在 DSH Headless 已安装 Auto Review 时可开启；先进行无副作用读取，再尝试不写盘的模型审核拒绝场景。不要使用破坏性命令做测试。
8. 会话续接、任务取消、恢复历史、20 次切换后端，检查临时 `dsh-overlay-*.yml` 清理和旧用户目录、配置不受影响。

**验证限制：** CI 运行的是模拟 DSH CLI 的完整 GJS 调用和 Node 纯逻辑/脚本测试；不能代替用户本机版本的真实模型网络、权限预设、Wayland IPC、Chrome 安装完整性与桌面可见性。若最新 CI 未完成或失败，以工作流实际状态为准，不要声称全部通过。
