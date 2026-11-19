# Quick Chat 2026-11-19 第三轮运行时审查：缺陷与优化清单

> **面向 Coding Agent 的可执行审查任务，不是测试通过证明。** 审查基线：`f14234fd1a0541eb273ce442880f5dd607ef0acf`；仓库：`lbg2002/gnome-quick-chat`，分支 `main`。源码取自该提交；所引用行号固定为这一版本。审查方式为 GitHub 逐文件静态阅读 + 复核对应测试与最新 CI；**未在用户 Ubuntu/GNOME Shell 50 电脑上运行、未拥有真实 ZCode/Codex 账号或可执行文件、未进行性能采样**。本报告不宣称已经实机复现。上一轮 A–F/R1–R12 大部分有实现，不得简单照着旧清单重新重构。

## 0. 最重要的结论与可信度

**P0-01 是明确的生产调用链参数类型错误，具有直接导致「连接后端失败」的能力，必须在真实 GJS 中优先复现与修复。** 当前 [CI](https://github.com/lbg2002/gnome-quick-chat/actions/runs/44430771409) 成功只说明运行过的测试通过；GJS 启动测试绕过了 `ChatController`，因此没有覆盖用户实际点击随问建立连接的那条入口。

信心标识：
- **源码确定**：路径、条件或返回值在源码中可直接核实；触发后的实际桌面表现仍需验证。
- **需故障注入**：可能发生不一致，但不能仅凭静态代码断言已造成丢失或崩溃。
- **优化/风险**：非已证实功能 Bug，需基准测试或真实版本/环境验证后才动手。

### 本轮任务索引

| ID | 等级 | 分类 | 主题 | 依据性质 |
| --- | --- | --- | --- | --- |
| QA-01 | P0 | 连接阻塞 | 普通 JS Cancellable 传入 Gio 原生 API | 源码确定 |
| QA-02 | P0 | 连接阻塞 | 外层丢失取消参数；真正控制器入口没有 GJS 测试 | 源码确定 |
| QA-03 | P1 | 数据完整性 | 关闭/切换/新建会话不检查 flush 返回值 | 源码确定，后果需故障注入 |
| QA-04 | P1 | 数据完整性 | 删除会话吞掉错误且不检查删除结果 | 源码确定，后果需故障注入 |
| QA-05 | P1 | 交互 | OpenAI 预算拒绝时可能丢失输入和附件 | 源码确定，需 UI 回归 |
| QA-06 | P1 | 性能 | 显式 OpenAI 仍预探测本地 ZCode/Codex | 源码确定 |
| QA-07 | P1 | 测试有效性 | 真实 GNOME Shell 入口/已安装扩展未测 | 源码确定 |
| QA-08 | P1 | 安装可靠性 | 启用失败不回滚、升级强制启用原本禁用的扩展 | 源码确定 |
| QA-09 | P2 | 状态与诊断 | 选择器的冷缓存后端提示不等于实际运行后端 | 优化/风险 |
| QA-10 | P2 | 兼容/权限 | 真 ZCode/Codex 版本、Bridge 与沙箱能力验证不足 | 环境风险 |
| QA-11 | P2 | 性能与维护 | Shell 实测性能、缓存/Actor 上界、复杂度 | 优化 |

## 1. 逐项审查和修复验收

### QA-01 · P0：连接取消对象类型错误（先修）

**证据链（全部固定于基线提交）**：

1. [core/chatController.js L5–30](https://github.com/lbg2002/gnome-quick-chat/blob/f14234fd1a0541eb273ce442880f5dd607ef0acf/core/chatController.js#L5-L30)：`createConnectionCancellable()` 返回带 `cancel() / is_cancelled() / connect()` 的普通 JS 字面量，不是 GObject `Gio.Cancellable`。`connect()` 返回数组长度，`disconnect()` 为空实现。
2. [core/chatController.js L181–232](https://github.com/lbg2002/gnome-quick-chat/blob/f14234fd1a0541eb273ce442880f5dd607ef0acf/core/chatController.js#L181-L232)：`ensureConnected()` 创建上述对象，并将其作为 `options.cancellable` 传给 `BackendClient.startAsync()`。
3. [backendClient.js L544–561](https://github.com/lbg2002/gnome-quick-chat/blob/f14234fd1a0541eb273ce442880f5dd607ef0acf/backendClient.js#L544-L561)：该对象继续传给 `resolveBackendRuntimeAsync()`。
4. [core/backendDetect.js L262–289](https://github.com/lbg2002/gnome-quick-chat/blob/f14234fd1a0541eb273ce442880f5dd607ef0acf/core/backendDetect.js#L262-L289) 中经由 `detectBackendSelectionAsync`、`queryFileSignatureAsync` / `readFileHeadAsync`，进入 [core/backendDetect.js L140–165、L266–285](https://github.com/lbg2002/gnome-quick-chat/blob/f14234fd1a0541eb273ce442880f5dd607ef0acf/core/backendDetect.js#L266-L285) 的 `Gio.File.read_async` / `query_info_async`。这些原生接口要求 `Gio.Cancellable` 或 `null`，不是仅有同名方法的 JS 对象（参见 [Gio API](https://docs.gtk.org/gio/iface.File.html)）。
5. 只要存在需要读取/查询的 CLI 文件，原生 GI 参数校验可能抛类型异常，控制器最终报「连接失败」。**这是源码调用链确认的类型不匹配，不等于已在用户机器上捕获具体异常堆栈。**

**修复要求**：

- [ ] 保持 `ChatController` 的纯 JS 可测试性：增加 `createCancellable` 依赖注入，生产扩展由 `extension.js` 注入 `() => new Gio.Cancellable()`；Node 测试注入实现相同接口的假对象。或者引入明确的适配层，将控制层信号转化为专用 `Gio.Cancellable`，但 **绝不可将 JS 假对象传给 GObject 原生 API**。
- [ ] GJS 连接测试明确断言生产传入 `BackendClient.startAsync()` 的对象 `instanceof Gio.Cancellable`；加真实文件、CLI 探测、取消测试，不依赖仅在 Node mock 中运行的 Gio。
- [ ] 对异步取消统一使用与真实 Gio 对象兼容的 `connect` 和 `disconnect`；检查请求完成、切换后端和扩展 disable 时不会残留监听器或访问过期 Actor。

**验收**：通过完整真实 GJS `ChatController.ensureConnected → _loadRuntimeEnvironment → BackendClient.startAsync → Gio backendDetect → get_state / get_messages`，在 ZCode/Codex/OpenAI 三种配置下均成功；在读取文件期间取消无 GJS 类型错误。必须先让测试在旧代码下复现失败。

### QA-02 · P0：扩展外层没有转发取消参数，测试覆盖盲区（与 QA-01 同工作包）

- **源码确定**：[extension.js L125–129](https://github.com/lbg2002/gnome-quick-chat/blob/f14234fd1a0541eb273ce442880f5dd607ef0acf/extension.js#L125-L129) 的 `loadRuntimeEnvironment: () => this._loadRuntimeEnvironment()` 忽略控制器传入的 `{cancellable}`；而 [extension.js L1073–1083](https://github.com/lbg2002/gnome-quick-chat/blob/f14234fd1a0541eb273ce442880f5dd607ef0acf/extension.js#L1073-L1083) 已支持该参数。修改为透传参数，并在异步读取密钥、检测、后端配置完成后校验是否过期。
- **测试盲区**：[tests/gjs_smoke.js L460–500](https://github.com/lbg2002/gnome-quick-chat/blob/f14234fd1a0541eb273ce442880f5dd607ef0acf/tests/gjs_smoke.js#L460-L500) 的两个后端启动测试直接 `new BackendClient` 并 `startAsync`，没有实际调用 `ChatController`。Node 的 ChatController 测试用了 Gio mocks，不能证明原生参数兼容。
- [ ] 为 GNOME Shell 中锁屏、快速切换后端、开关面板、关闭扩展增加 lifecycle/generation/cancel 回归；不吞掉未知连接错误。
- [ ] 连接失败诊断显示真实处理阶段 `settings/keyring → CLI discovery → CLI probe → SessionStore load → ready`，只显示脱敏原因和可复制的错误信息。避免只显示泛化的“连接后端失败”。
- [ ] 复核最近几次连接“已修复”的 CI 断言确实经过生产 UI 委托链路，不能以新增独立 adapter 测试替代。

### QA-03 · P1：flush 失败被忽略，可能误以为历史已保存

- [core/chatController.js L150–164](https://github.com/lbg2002/gnome-quick-chat/blob/f14234fd1a0541eb273ce442880f5dd607ef0acf/core/chatController.js#L150-L164) 重连时调用 `flush_session`，只捕获异常，不验证返回值 `{ok:false, hasUnsavedChanges:true}`，随后仍 `stopClient()`。
- [extension.js L2560–2579、L2699–2721](https://github.com/lbg2002/gnome-quick-chat/blob/f14234fd1a0541eb273ce442880f5dd607ef0acf/extension.js#L2699-L2721) 恢复/新建会话同样忽略 `flush_session` 的 `ok`。当前 [backendClient.js L681–694](https://github.com/lbg2002/gnome-quick-chat/blob/f14234fd1a0541eb273ce442880f5dd607ef0acf/backendClient.js#L681-L694) 确实返回了 `SessionStore.flush()` 的结果，因此 UI 完全可以判断。
- [ ] 提取统一的 `flushBeforeSessionTransition`，只有确认 `ok:true` 或用户明确接受丢失风险/已成功导出内存历史，才允许切换和关闭当前实例。失败时保留未保存状态与当前内容；不要静默继续。
- [ ] 失败注入：消息 A 磁盘写入持续失败 → 立即切换后端/新建/恢复历史 → 仍能看到 A 且收到未保存提示；支持重试并校验落盘。不允许“队列结束”冒充“持久化完成”。
- **注**：不声称一定发生数据丢失；这里只能从调用链确定存在无条件继续路径。

### QA-04 · P1：删除会话失败时 UI 可能仍跳转

- [extension.js L2610–2640](https://github.com/lbg2002/gnome-quick-chat/blob/f14234fd1a0541eb273ce442880f5dd607ef0acf/extension.js#L2610-L2640)：先调用 `stopClient()`，然后 `try { await deleteStoredSessionAsync(victimId); } catch (_) {}`，无论是异常还是 `{ok:false}` 都会继续生成新 session ID、清空 UI。
- [core/sessionStore.js L559–570](https://github.com/lbg2002/gnome-quick-chat/blob/f14234fd1a0541eb273ce442880f5dd607ef0acf/core/sessionStore.js#L559-L570) 返回的是结构化删除结果，不能只靠是否抛异常判定成功。
- [ ] 检查并处理 `res.ok`，删除失败时保留/恢复旧会话 ID 与 UI，展示具体错误和重试入口；对同一会话的写队列做终止确认。
- [ ] 磁盘权限不足、文件被占用、部分删除失败与正常删除均应有独立回归。保留普通“新建会话”和“删除会话”不同语义。

### QA-05 · P1：OpenAI 模型发现后的预算拒绝可能丢失附件和草稿

- [extension.js L1544–1574](https://github.com/lbg2002/gnome-quick-chat/blob/f14234fd1a0541eb273ce442880f5dd607ef0acf/extension.js#L1544-L1574) 在请求确认接收前先清空输入与附件。
- [backends/openaiAdapter.js L779–794](https://github.com/lbg2002/gnome-quick-chat/blob/f14234fd1a0541eb273ce442880f5dd607ef0acf/backends/openaiAdapter.js#L779-L794) 模型目录发现后超出上下文预算，返回 `{disposition:'rejected_budget'}`（非 throw）。
- [extension.js L1583–1624](https://github.com/lbg2002/gnome-quick-chat/blob/f14234fd1a0541eb273ce442880f5dd607ef0acf/extension.js#L1583-L1624) 仅在 catch 恢复草稿/附件，正常返回的 `rejected_budget` 不走该分支。终止事件虽可能解除忙碌状态，但不会自动恢复输入。
- [ ] 将拒绝预算、未配置、用户取消、连接失败、真正完成明确区分；保留不可变 `DraftSnapshot`，请求被明确拒绝时恢复正文+全部附件并移除/标记未发送成功的 UI 消息卡片。避免把已触发实际副作用的失败一律自动重试。
- [ ] 真 GJS/UI 测试：先得到大上下文预算，`/models` 发现较小窗口并拒绝请求，确认编辑框和附件回到发送前状态，SessionStore 没有幽灵用户消息。

### QA-06 · P1：显式 OpenAI 后端也会预探测本地 ZCode/Codex（冷启动额外开销）

- [core/backendDetect.js L1034–1097](https://github.com/lbg2002/gnome-quick-chat/blob/f14234fd1a0541eb273ce442880f5dd607ef0acf/core/backendDetect.js#L1034-L1097)：无论 `configuredBackend` 为 `openai`、`codex`、`zcode` 或 `auto`，均默认构造 `new Set(['zcode','codex'])`，并可能执行 CLI `--version`。
- [extension.js L1073–1085](https://github.com/lbg2002/gnome-quick-chat/blob/f14234fd1a0541eb273ce442880f5dd607ef0acf/extension.js#L1073-L1085) 每次冷连接会先检测；若本地 CLI 卡住，显式选择纯 HTTP API 仍有等待 CLI 探测超时的风险。
- [ ] 明确指定 `openai` 时跳过所有本地 CLI 探测；`codex` 只识别 Codex；`zcode` 只识别 ZCode；`auto` 按顺序检测并尽早短路，缺省其他后端不影响明确选择。UI 后台刷新可独立获取全部已安装后端列表。
- [ ] 加统计与测试：三个 5 秒卡住的假 CLI，OpenAI 显式启动不应发起一次子进程或增加 CLI 探测等待时间。冷/热启动分别计时，不能只测缓存命中。

### QA-07 · P1：CI 通过不代表安装/连接路径和真实 CLI 已通过

- 最新成功 [CI 运行](https://github.com/lbg2002/gnome-quick-chat/actions/runs/44430771409) 覆盖 Node 单测、真实无头 GJS 模块、模拟 ZCode/Codex、模拟 Soup。没有验证用户实际已安装 `~/.local/share/gnome-shell/extensions/quick-chat@lbg2002.github.io` 的文件、真实 GNOME Shell 日期菜单挂载、设置迁移/登录态、真实 ZCode/Codex 版本。
- [ ] 将 QA-01 的真实 GJS `ChatController` 入口作为必测；将一套安装包暂存目录 `gjs -m` 导入/运行测试加入 CI，检查源仓库与发布包相同。
- [ ] 增加可重复执行的人工 smoke 脚本/清单：`gnome-shell --version`、`gnome-extensions info`、`command -v zcode/codex`、`--version/--help`、诊断连接阶段、对话成功与取消；收集日志时自动删除 API Key 与提示词。
- [ ] 对实际 ZCode、Codex 各至少记录一个已验证版本；环境不满足时标记 `blocked`，不把 mock 结果宣称为真机完全兼容。

### QA-08 · P1：安装结束前失去回滚能力，升级改变用户启用状态

- [install.sh L115–157](https://github.com/lbg2002/gnome-quick-chat/blob/f14234fd1a0541eb273ce442880f5dd607ef0acf/install.sh#L115-L157)：`swap_committed=true` 和删除旧备份发生在 `gnome-extensions enable` 前；即使 enable 失败也只生成提示并正常结束，无法自动回滚。升级还会主动 enable 先前被用户禁用的扩展。
- [ ] 在实际激活/基础健康检查通过前不要丢备份；允许 Wayland 需要注销的“延迟生效”状态，但准确区分安装成功、已启用和已加载旧代码，绝不可对未运行的新代码承诺正常。
- [ ] 记录旧启用状态并保持；失败可恢复旧目录并适当还原原启用状态，提供显式回滚命令。脚本测试覆盖 gnome-extensions 不存在、返回失败、Wayland 延迟加载和用户原本禁用。

### QA-09 · P2：后端显示与实际选择有短暂不一致风险

- [core/backendDetect.js L948–998、L1144–1164](https://github.com/lbg2002/gnome-quick-chat/blob/f14234fd1a0541eb273ce442880f5dd607ef0acf/core/backendDetect.js#L948-L998)：`peekBackendSelection` 在冷缓存的 `auto` 情况优先给 OpenAI URL 或猜测 ZCode，表示的只是 UI 占位；直到异步检测完成才有真实选择。
- [extension.js L390–396](https://github.com/lbg2002/gnome-quick-chat/blob/f14234fd1a0541eb273ce442880f5dd607ef0acf/extension.js#L390-L396) / 模型选择器读取这一近似值。若标签未明显标注“检测中”，可能出现暂时显示模型/权限属于另一后端的 UI。
- [ ] UI 使用 `detecting` / `fromCache`，优先显示连接控制器最后确认的实际后端；检测中时锁定可能误切换的高权限按钮，检测完成后刷新模型与模式。验证三个后端切换场景。

### QA-10 · P2：CLI 版本与权限边界仍要真实验证

- [backendClient.js L314–465](https://github.com/lbg2002/gnome-quick-chat/blob/f14234fd1a0541eb273ce442880f5dd607ef0acf/backendClient.js#L314-L465) 依赖本地 CLI 参数和帮助输出。ZCode 桥接还依赖内部 Broker 钩子。CI 使用合成 help 文本，不能证明不同正式发行版 CLI 均有一致的审批/沙箱能力。
- [ ] 记录所支持的 `zcode --version / codex --version` 与对应版本参数清单；在真实可执行文件上测试只读、审批、取消、多轮恢复。桥接不工作时只能安全降级/拒绝高风险调用。
- [ ] 日志、诊断、模型目录不得回显凭据；对模型权限能力的描述必须区分“CLI 内建只读沙箱”与“代理审批/提示词约束”。这些是兼容性风险，**本轮没有证明发生了权限越界**。

### QA-11 · P2：性能与维护建议（需要测量，不是缺陷结论）

- [ ] 真实 GNOME 50 测量：扩展关闭/空闲/打开首屏/30k字流式/100工具事件/锁屏、ZCode 和 Codex 进程树的 Shell RSS/CPU、UI p95、首字、Agent 整体耗时。报告采样时间及机器，不设伪造实测数值。
- [ ] 量化模型目录冷启动、缓存刷新；历史归档后 Actor 数量与 JS 数据数量各自是否有上限。只有 profiler 证明热点后才再拆 UI 代码。
- [ ] `AGENTS.md` 旧章节有“已完成”的勾选，但不代表实机验证。将任务分成 `implemented`、`test_passed`、`desktop_verified`、`blocked`、`regressed`，避免下一位 Agent 看到旧的勾选而跳过 QA-01。
- [ ] 优化诊断可观测性（连接各阶段、实际 CLI 路径、真实模型、沙箱权限、配置修订号、错误码），默认绝不收集用户对话原文、API Key 或大段工具日志。

## 2. 建议给 Coding Agent 的执行顺序和提交纪律

1. **先做 QA-01/QA-02（同一小工作包）**：写真实 GJS 失败先行测试，修正原生 `Gio.Cancellable` 类型与外层参数透传。只要这个问题未修好，不应宣称 ZCode/Codex 连接问题已经解决。
2. **再做 QA-03/QA-04/QA-05**：数据写失败注入、会话切换与删除事务、OpenAI 预算拒绝恢复。保持旧 SessionStore 格式和用户历史。
3. **接着 QA-06/QA-07/QA-08**：按需检测 CLI、安装包与实际控制器测试、启用/回滚行为。
4. **最后 QA-09/QA-10/QA-11**：UI 诊断、真实 CLI 兼容和性能测量；不得因单元测试 green 宣称实机 green。

每个任务在当前最新代码中先复核，写失败先行测试，最小修复，独立提交。执行 `npm test`、`gjs -m tests/gjs_smoke.js`、`node --check`、`glib-compile-schemas --strict --dry-run schemas`、`bash -n install.sh uninstall.sh pack.sh`；只有实际运行的命令才能标通过。CI 完成后复核运行结果及测试是否命中真正生产路径。无法进行 GNOME 50/Wayland 实机验证时标 `blocked` 而不是 `pass`。绝不强推、覆盖用户同期提交或擅自更改外部 ZCode/Codex 全局配置。

## 3. 对应的快速复现矩阵

| 场景 | 预期 / 检查点 |
| --- | --- |
| 新用户第一次连接 ZCode | `ChatController` 传入真正 `Gio.Cancellable`，后端身份和状态可正常读取 |
| 新用户第一次连接 Codex | 同上；自定义路径、NVM/Cargo/PATH 各至少一种 |
| 选择 OpenAI 且本地 CLI 故意卡住 | 完全不等待 CLI version/help |
| 连接中立即切换后端 / 锁屏 / disable | 旧任务取消，新客户端不受旧结果污染 |
| 写入失败后新建/切换/重连 | 不静默丢弃未保存记录 |
| 删除文件遇到 EACCES | 提示失败，不假装删除成功 |
| 模型自动发现小上下文而拒绝发送 | 输入内容、附件、UI 和磁盘历史一致 |
| 安装脚本启用失败 / 原本被禁用 | 旧版本可回滚，原启用状态不被意外改变 |
| 最新 ZCode/Codex 真正执行一次只读任务 | 版本、权限、会话状态、取消与日志都可核验 |

## 4. 必要的透明说明

本轮没有编造本机错误日志，也没有修改源码或让 Agent 自动执行危险命令。`P0-01` 的**类型不匹配是确定的**，但造成用户所见错误的具体堆栈仍需 GNOME Shell 日志/真实 GJS 连接测试验证；其余条目按上面的置信度和失败注入要求处理。请勿把“静态确定”误写成“已实机复现”。

