# 第三轮 QA-01–QA-11 实施与验收记录

**原始审查基线：** `61452fe06ab02753f58ed688255f1d39335168ab`（审查报告基于 `f14234f` 源码）。  
**变更范围：** ZCode / Codex / OpenAI 三后端的 GNOME Quick Chat 扩展；保留现有会话文件、配置格式与 GUI，不重引入 Pi。

> 状态分开记录：`implemented` 表示代码已提交；`ci_passed` 表示自动化测试在某次提交上成功；`desktop_verified` 需要用户真实 GNOME 50 / Wayland；`blocked` 表示本次连接环境无法做对应实机验证。**CI 通过不表示真实 CLI 可正常登录、审批或执行任务。**

| ID | 代码状态 | 自动化验收 | 尚需现场验证 |
| --- | --- | --- | --- |
| QA-01 | implemented：ChatController 注入原生 Gio.Cancellable | GJS 经 ChatController → BackendClient → ZCode/Codex mock CLI | blocked：真实桌面、真实 CLI |
| QA-02 | implemented：外层取消参数透传；GJS 控制器入口回归；连接阶段错误定位 | GJS 模拟启动及 Node 连接故障测试 | blocked：锁屏/重载 GNOME Shell |
| QA-03 | implemented：reconnect/new/restore 前必须确认 `flush_session.ok` | Node 模拟写入失败测试 | blocked：实机磁盘写入故障 |
| QA-04 | implemented：删除失败不跳转；I/O 不吞删除错误；结构化失败 | Node 正常/EACCES/ENOTEMPTY 故障注入 | blocked：真实文件系统权限异常 |
| QA-05 | implemented：OpenAI `rejected_budget` 恢复正文及附件、移除未发送卡片 | 语法/集成测试经过该源码加载；缺独立 Shell UI 断言 | blocked：真实桌面附件+小上下文场景 |
| QA-06 | implemented：显式后端按需探测，本地 OpenAI 不走 CLI | Node 确认 OpenAI 不执行 CLI 探测 | blocked：真实安装冷启动性能 |
| QA-07 | implemented：安装后的目录复制 GJS 集成测试；只读诊断脚本 | CI 对安装目录执行 GJS smoke | blocked：真实登录桌面/三后端授权 |
| QA-08 | implemented：保持禁用状态；激活失败回滚；Wayland 延迟加载保留备份 | Node shell 假命令测试启用失败/禁用升级 | blocked：真实 Wayland 扩展启用 |
| QA-09 | implemented：实际模型/后端状态优先，不依赖冷缓存猜测 | 模块语法及现有模型状态单测 | blocked：真实 UI 切换和视觉检查 |
| QA-10 | 可执行检查脚本已交付：`scripts/diagnose-local.sh` | shell 语法检查 | **blocked**：缺实际 ZCode/Codex 安装、账户与真实授权流程 |
| QA-11 | 可执行采样脚本已交付：`scripts/measure-shell.sh` | shell 语法检查 | **blocked**：缺 GNOME 50 现场性能测量、真实 CPU/RSS 数据 |

## 主要源码提交（按任务）

- **QA-01 / QA-02：** [连接对象注入](https://github.com/lbg2002/gnome-quick-chat/commit/3b40e165cb6c9e937e761eae3fccdbc5db65ac69)、[外层参数透传](https://github.com/lbg2002/gnome-quick-chat/commit/1b8b72432fb5dc74f63e9b34d7582d7e2b7c5cf3)、[GJS 控制器全链路测试](https://github.com/lbg2002/gnome-quick-chat/commit/fab777e32c149ef8d7d4449028e9e6fb9b1da44d)。
- **QA-03 / QA-04：** [阻止未保存重连](https://github.com/lbg2002/gnome-quick-chat/commit/d6e2b026105863b2e15d96891ac27e5958befcd2)、[会话转换与删除错误反馈](https://github.com/lbg2002/gnome-quick-chat/commit/08c9cbdd9ae928d24e3106bae555764220422030)、[Gio 删除错误处理](https://github.com/lbg2002/gnome-quick-chat/commit/e2bdf87d24579ddaa29457bd62e7d4ac45609afa)、[持久化删除失败返回](https://github.com/lbg2002/gnome-quick-chat/commit/6ae78dc8c6ce348f1dc4cac3c20a38978d42abf5)。
- **QA-05 / QA-06：** [OpenAI 草稿恢复](https://github.com/lbg2002/gnome-quick-chat/commit/168e8b277957250370dce72af0f1f6bf0f674d8d)、[按需 CLI 检测](https://github.com/lbg2002/gnome-quick-chat/commit/efc42a2fac4481656173292fbe69f70e1e6ce7c9)、[OpenAI 无 CLI 回归测试](https://github.com/lbg2002/gnome-quick-chat/commit/4e618d61e930d913210f6d663f4e618ccd7b08d3)。
- **QA-07 / QA-08：** [安装目录 GJS 测试](https://github.com/lbg2002/gnome-quick-chat/commit/390f948e36bf7297648b2c81f918ed0eace3f05b)、[安装器回滚](https://github.com/lbg2002/gnome-quick-chat/commit/3f2dc05f6596742e9c5460a4aa4023f814da8225)、[安装器回归测试](https://github.com/lbg2002/gnome-quick-chat/commit/4f716283880405093b54c43ed4db439caf5791bf)。
- **QA-09：** [真实后端显示](https://github.com/lbg2002/gnome-quick-chat/commit/6c21c5e57073952ff9f2b0188c3ce1bb754fac97)。
- **QA-10 / QA-11：** `scripts/diagnose-local.sh`（只读本机版本诊断）、`scripts/measure-shell.sh`（不采集用户内容的 Shell CPU/RSS 基线测量）。
- **附加修复：** R3.5 测试清理等待异步持久化；CI 不再被偶发 ENOTEMPTY 干扰；连接错误显示具体初始化阶段。

## 自动化验证

已观察到成功的 GitHub CI：

- [CI #44460270435](https://github.com/lbg2002/gnome-quick-chat/actions/runs/44460270435)：含更新后的安装目录 GJS 测试、Node 测试和脚本检查（提交 `f009d97f4`）。
- 后续代码变更仍须逐提交查看 [最新 CI](https://github.com/lbg2002/gnome-quick-chat/actions)。不要把此前通过的运行结果归给尚未测试的最新 HEAD。

测试覆盖主要为模拟 CLI、真实 GJS/Gio/Soup（无头）、Node 单元/故障注入、安装脚本模拟环境。没有人工操作 GNOME 50 的截图、状态日志或实测性能数据。

## 用户本机最终验收（必须手动完成）

使用实际 GNOME Shell 50/Wayland、ZCode/Codex CLI 环境：

1. `git pull --ff-only origin main && bash install.sh`；Wayland 注销并重新登录，让 GNOME Shell 确实重新装载 JS 文件（安装输出会区分已请求启用与已验证状态）。
2. `bash scripts/diagnose-local.sh`：检查扩展状态和真实 CLI 版本。脚本不读取会话内容、密钥或提示词。
3. 分别连接 ZCode、Codex、自定义 OpenAI API，先测试纯问答，再测试只读文件访问与取消；记录 GUI 连接诊断中的具体失败阶段，**不要公开凭据或私有文件正文**。
4. 连续切换引擎/打开面板/锁屏解锁，确认没有旧回合更新新会话、没有未保存历史丢失、无需重复选择附件。
5. `bash scripts/measure-shell.sh 30`，分别在扩展空闲、面板打开、30k 字回答、100 工具轨迹时采样；分别测扩展开/关基线。这个脚本本身**不提供任何性能达标结论**。
6. 如果真实授权或桌面测试失败：保留错误阶段、可重现步骤和脱敏日志后修复，不得因为 GitHub CI 通过而发布“全部正常”。

## 剩余改进注意

- QA-05 需要真实 UI 脱敏回归，尤其是异步拒绝后 `agent_settled` 已清除 turn state 的场景。
- QA-03/04 的文件失败路径已有 Node 故障注入，但 GNOME Shell 进程加载中、文件系统权限变更时仍需现场验证。
- QA-08 无法在 CI 证明 Wayland 热升级马上加载新 JS；允许保留旧版备份和明确的重新登录建议。
- ZCode Bridge 内部 Broker 的正确性取决于所安装的 ZCode 版本，必须按真实 CLI 执行能力验收。
- QA-11 只有采样工具，没有用户设备的实测结果或 p95 指标；**本轮不作性能保证**。
