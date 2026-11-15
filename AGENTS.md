# AGENTS.md — Quick Chat（随问）改进实施指南

> 本文是仓库维护者指定的下一轮开发任务清单，供 Codex、ZCode 等 Coding Agent 直接读取并执行。审查基线：main @ c0325fa0eb6f66a5648c93508400fc44a12d37d3（2026-11-15）。开始修改前先检查最新代码，若某项已经修复，补充回归测试并标记完成，不要重复重构。本文描述的是待实施方案，不代表当前已修复或已通过性能测试。

## 0. 产品定位与硬性约束

- **彻底移除 Pi 后端，只保留 ZCode CLI、Codex CLI、OpenAI 兼容 API 三种后端。** 不新增其他 Agent 后端，不维护 Pi RPC 进程、空闲回收、协议或配置兼容层。旧配置迁移和历史导入属于例外，仅用于无损升级。
- 保持 GNOME Shell 50 原生 GJS / St / Clutter 实现，默认嵌入原生日期菜单；不引入 Electron、WebView、大型 UI 框架、数据库或额外常驻服务。
- 保留中文优先、紧凑界面、彩色圆点轨迹、交互式提问及审批、快捷键和剪贴板随问。不要将随问变成完整的多会话聊天客户端或 AIOS。
- 优先保证 GNOME Shell 稳定、安全、低开销；普通聊天不应自动升级为 Agent 或扩大权限。所有新增操作遵循最小权限与明确用户授权。
- 保留现有扩展 UUID、GSettings schema ID、数据目录和安装方式；升级不得删除用户历史、其他后端的配置或外部 CLI 的原生数据。
- 每项修复优先补可复现测试，再修改实现；每一阶段独立提交，确保可回滚。不要仅更新 README 或以 TODO 代替实际修复。
- 不要无故修改外部 ZCode/Codex 程序、全局配置、用户 HOME 内容或已安装软件；测试使用隔离临时目录和假后端。
- 本文中的文件名/行号基于审查提交，重构后应按函数与职责定位。建议参数为初始工程目标，必须实测后调整，不得把静态推断写成已测性能。

## 1. 实施顺序

| 阶段 | 优先级 | 范围 | 完成条件 | 状态 |
| --- | --- | --- | --- | --- |
| A | P0 | 移除 Pi、配置迁移、后端检测 | 三后端可用，旧安装可升级 | ✅ 已完成 |
| B | P0 | 审批安全、回合状态、子进程取消 | 权限不扩大、回合隔离、失败准确 | ✅ 已完成 |
| C | P0/P1 | 会话数据一致性、流协议与密钥 | 历史正确、流终止可靠、密钥不泄露 | ✅ 已完成 |
| D | P1 | GNOME 主线程与长文本性能 | 有可复现性能数据及回归测试 | ✅ 已完成（纯 JS 流式解析/调度基准已通过，GNOME 50 桌面实测见第 8 节人工验收） |
| E | P1 | 模块化、配置和 GNOME 生命周期 | 可维护、可独立测试、安装可回滚 | 进行中 |
| F | P2 | 桌面上下文、快捷动作、会话恢复 | 提升日常使用效率，不增加常驻负担 | 待实施 |

优先完成 A–C 再做功能扩展。D、E 可按实际依赖拆分穿插实施。不得在安全和数据一致性未解决前默认启用更强权限或复杂自动化。

## 2. A：移除 Pi 后端（P0，首个独立提交）— ✅ 已完成

### A1. 删除运行时与依赖 — ✅ 已完成

审查入口：piClient.js、core/backendDetect.js、protocol.js、extension.js、prefs.js、schemas/org.gnome.shell.extensions.quick-chat.gschema.xml、tests/protocol.test.js。

- [x] 将 piClient.js / PiClient 重命名为 backendClient.js / BackendClient（也可直接实施第 6 节适配器结构），更新所有 import、install.sh、pack.sh、CI 语法检查和测试入口。避免保留旧名称作为长期兼容层。
- [x] 移除 Pi 专用 buildArgs、RPC request/response 队列、读写方法、持久进程、空闲计时器、Pi first-turn 标记、Pi 模型硬编码目录、Pi 可执行文件探测和 Pi 专属测试。共享的 Gio 异步 I/O、XDG 路径获取、权限处理、TurnController 继续保留。
- [x] 三个后端统一使用同一套 SessionStore、TurnController、标准化事件与前端状态。ZCode/Codex 按回合启动 CLI，OpenAI 使用 Soup HTTP 流；无需新增常驻 CLI 进程。
- [x] 删除模型选择器、设置页、空状态、能力矩阵、metadata.json、README、docs/index.html、SVG 架构图等所有仍宣称支持 Pi 的内容。不要删除历史中用户实际写过的文本。
- [x] 使用 ripgrep 全仓搜索 Pi 专属符号与文案，人工区分普通英文单词及合法的迁移代码。检查安装包不会包含已移除文件。

### A2. 向后兼容迁移 — ✅ 已完成

当前 schema 共享 backend、pi-path、provider、model、reasoning-effort 等字段，且 backend 允许 auto/pi/zcode/codex/openai。

- [x] 增加配置版本或迁移标记；旧 backend=pi 安全迁移为 auto 并明确告知用户重新选择后端。未配置可用引擎时进入明确的未配置状态，不能返回一个不存在的 ZCode。
- [x] 将旧 pi-path 迁移为独立 zcode-path 或 codex-path **仅在验证身份后**；原本的 Pi 路径不应被误当成其他 CLI。
- [x] 保留旧 schema 字段仅用于一次性迁移，之后停止读写并在后续版本移除；pi-idle-minutes 不再展示或影响运行。迁移幂等，可重复运行；不要清空原始共享 provider/model，先按已验证的旧 backend 迁移对应字段。
- [x] 默认 auto 检测顺序建议 ZCode → Codex → 已配置的 OpenAI；明确选择的后端不可悄悄切换为另一后端。检测依据实际 executable/CLI identity，而不是任意路径存在。无后端时提示配置方式。
- [x] 用户历史中原有 Pi 会话保持原文件不变；如果能安全解析其本地会话格式，可提供显式只读导入为普通历史，不承诺恢复 Pi 执行状态，也不要求实现 Pi RPC。不能解析时保留原始数据并给出提示。
- [x] 旧版本 SessionStore JSON/JSONL 会话必须可读取。不要把旧 Pi session ID 当成 ZCode 或 Codex 的远端 ID。

验收：旧 backend=pi/auto/zcode/codex/openai 配置分别升级；已安装三个后端、只有一个后端、无后端、无效路径均有明确结果；不存在对 Pi 的运行依赖；npm test 与严格 schema 编译通过。

## 3. B：安全、回合与进程（P0）— ✅ 已完成

### B1. 权限规则必须默认保守 — ✅ 已完成

现状：protocol.js computePermissionScope（269–336）和 zcodeBridge.cjs computeBridgeScope（58–108）均将 Shell 命令压缩空白并截断至 120 字符作为授权键；未知工具默认允许整个工具会话授权；桥接会自动匹配已批准范围。前缀碰撞、引号内空白变化和未知工具范围扩大均为实际静态缺陷。

实施：
1. [x] Shell 命令默认只允许本次执行。若保留重复授权，使用无损完整命令、工具标识、规范化 cwd、影响权限的完整参数及会话 ID 生成确定性授权键（例如规范序列化后 SHA-256）。不得用展示摘要作为授权键，不得截断或压缩命令。
2. [x] 未知工具、交互式提问、涉及高风险操作的工具默认禁止会话级授权。正则只能辅助展示风险，不能作为安全边界。
3. [x] 文件权限使用规范化真实路径，检查相对路径、符号链接、目录边界、同名不同路径、修改目标与用户所见一致；路径解析失败时不扩大权限。不要仅依赖 startsWith('/etc/')。
4. [x] 网络授权按解析后的明确 scheme/host/port 及必要范围建立，注意重定向；无法确认实际目标时不自动批准。
5. [x] ZCode bridge 应是实际授权的权威决策点；GJS 与 CJS 使用共享可移植策略或同源生成并做一致性测试。不能只修 UI 规则而遗漏桥接。
6. [x] 审批 UI 显示完整命令、真实 cwd、路径、操作类型和风险，长文本可折叠并展开；拒绝、仅本次允许、范围允许语义清晰。会话级许可在新建会话、切换 workspace/后端、权限模式变化时撤销。
7. [x] 校验 requestId、turnId 与当前 pending request，拒绝未知/重复/过期响应；不要将无 ID 的响应匹配到任意第一项审批。多并行审批逐一管理，自动放行也必须通知 UI 对应 requestId 的 resolved 事件。审批取消/超时/输入流关闭全部安全拒绝；清理 AbortSignal 监听器。
8. [x] 现有 full 模式是明确的高权限模式：开启前给出一次明确提示，普通路由不得自动进入。只读模式不能宣称等价于系统级只读沙箱；实际保证取决于后端。

测试：相同 120 字符前缀的不同命令、引号内空白、不同 cwd、路径穿越/符号链接、未知工具、并行审批/重复审批、授权撤销、桥接失败，均应无意外自动放行。测试只使用模拟命令，不执行破坏性操作。

### B2. 三后端真实能力与 ZCode 桥接验证 — ✅ 已完成

现状：protocol.js buildZCodeArgs / buildCodexArgs（464–520），zcodeBridge.cjs（310–353），piClient.js bridge_ready 分支。
- [x] ZCode readonly 当前用 build + monkey patch DenyPermissionBroker；此模式允许用户明确审批有副作用的操作，因此 UI 应准确表达“需审批的 Agent”，不能宣称强制只读。若要提供严格只读，应有独立强制后端能力，否则不提供该承诺。
- [x] Codex chat 目前只是“不要调用工具”的提示词加 read-only sandbox，不能保证无工具。若所安装版本没有真实禁用工具的能力，就将该选项禁用/改为只读 Agent，并推荐 OpenAI API 用于真正纯问答。不得将提示词当成权限边界。
- [x] 通过实际版本的 CLI help/能力探测验证参数。不要假设任意版本均支持同一参数、事件或审批机制。
- [x] ZCode bridge 的 Object.defineProperty 钩子可能因内部实现升级失效。启动时建立带协议版本的握手并设超时，校验实际 patch 状态；对于依赖桥接的审批模式，未确认能力前不应启动可执行敏感操作的任务。若 CLI 无法保证安全握手顺序，应降级到已验证的受限模式或阻止任务。
- [x] 保留明确能力矩阵：纯问答、只读文件、文件写入、Shell、审批、网络、交互问题、取消、思考强度；按实际能力显示 UI。OpenAI API 仅普通问答，不自动赋予本地工具。
- [x] 确认 ZCode 临时配置覆盖确实应用了所选模型；写入失败不应悄悄使用另一个模型或权限模式。显示实际模型/后端和错误。

### B3. 统一回合状态与 UI 隔离 — ✅ 已完成

现状：core/turnController.js 已能隔离旧回合，但 extension.js _abort（2798–2815）、_send、_onEvent 主要检查连接 generation；旧取消完成回调可能覆盖新回合的 busy 状态；后端 snapshot/终止事件也没有完整 UI 隔离。

- [x] 每次发送生成唯一 turnId；绑定 clientGeneration、sessionId、messageId、后端进程、网络 cancellable、定时器、工具审批与卡片。所有异步事件与回调验证身份，不能只检查全局 busy。
- [x] 保留单次结算原则；统一状态 idle / starting / streaming / awaiting_approval / cancelling / completed / cancelled / failed / interrupted / timed_out。状态转换集中管理，UI 不自行猜测最终状态。
- [x] 修正多审批时文本/思考增量不应覆盖 awaiting_approval；watchdog 仅在最后一个审批解决后恢复。审批等待单独设可配置超时或显式取消策略。
- [x] 停止 A 后立即发送 B 时，A 的取消返回、stderr、旧定时器、审批响应和网络 EOF 都不能修改 B。锁屏、禁用扩展、新建会话与后端重连统一清理。
- [x] 合并并发 _ensureClient()，避免打开面板和连续 GSettings 变更重复创建连接；按一次配置事务重连。enable/disable 使用生命周期世代号，禁止旧异步回调操作重新启用后的 Actor。
- [x] 失败或取消后保留 partial 文本和状态，但不伪造“任务完成”。只有已确认的工具结束事件可标记成功；中断的运行中工具标为 interrupted/unknown。

### B4. CLI 子进程退出与进程树管理 — ✅ 已完成

现状：piClient.js terminateSubprocessGracefully（42–65），_runSingleTurnSubprocess（781–985）。stdout EOF 直接 settle，未完整使用 sawDoneMarker/退出状态；stderr 全局共享；SIGTERM/SIGKILL 只针对直接子进程。

- [x] 使用 Gio.Subprocess.wait_async，收集真实退出码/信号，结合后端规范终止事件与 EOF 判断结果。非零退出、无完成标记、截断输出不能直接记成功；若不同 CLI 的有效结束条件不同，按适配器定义。
- [x] 每回合独立 stdout/stderr/缓冲和资源上限；所有 reader 回调检查 turnId，限制单行长度、stderr 字节数、JSON 解析失败次数。
- [x] 用独立进程组或经过验证的用户级 systemd scope 管理进程树，取消时 TERM→短暂宽限→KILL；不得向 GNOME Shell 或无关进程发送组信号。只在自己创建的组/scope 范围终止。确保进程回收、管道关闭、定时器移除。
- [x] 临时 ZCode 配置含敏感字段，保持目录 0700、文件 0600，安全创建（避免符号链接），仅在进程真正退出后删除；异常退出后的孤立文件按限定目录和命名清理。
- [x] 尽量通过 stdin（若 CLI 版本支持）传输 Prompt，避免长问题暴露于进程参数、argv 长度限制或前导 '-' 参数解析问题；不支持时遵循 CLI 参数分隔规范并明确长度限制。
- [x] 取消/超时不会保证已经产生的外部副作用被回滚，UI 不作此承诺。

验收：假 CLI 模拟正常结束、无标记 EOF、非零退出、stderr 后到、超时、创建子进程、取消后马上发送新任务；检查无残留进程与错误 UI 状态。

## 4. C：会话、协议与密钥（P0/P1）— ✅ 已完成

### C1. 修复 JSONL 压缩竞争和持久化一致性（P0）— ✅ 已完成

现状：core/sessionStore.js appendMessage / _rewriteAllMessagesNow（199–237）。压缩任务在队列执行时读取实时 this.messages，会将后续待追加记录提前写入，导致重复消息。

- [x] 入队时生成不可变 record/snapshot；压缩任务仅写入其对应 revision 快照，之后的 append 只写自己的记录。元数据同样不能隐式读取后续变化的共享对象。
- [x] 给消息和回合添加稳定 ID、revision、role、createdAt、backend、modelId、replyTo、status。加载时按 ID 去重，保留顺序；旧数据迁移不丢失。
- [x] SessionStore.load 使用 single-flight Promise；同一 sessionId 的多实例写入通过共享队列/生命周期协调，避免旧客户端与新客户端同时写同一个文件。等待必要的写入完成再切换会话或重连。
- [x] appendLineAsync 必须检查写入及关闭结果；原子替换单文件不等于 meta 与 JSONL 跨文件事务。设计可恢复 revision/提交顺序，避免崩溃后元数据与日志不一致。
- [x] 写入失败可观察，UI 提示“历史未保存”，重试有界，不静默吞掉错误。损坏行隔离并记录，不能自动覆盖唯一历史副本。
- [x] 不要按单条消息无条件删除历史的另一半回合。当前 200 条限制可保留为默认热历史窗口，但完整历史与磁盘清理应明确用户策略；压缩按完整回合处理并测试单条超大消息。
- [x] 会话 ID 必须验证为受控格式，构建路径后保证处于数据根目录内；禁止相对路径逃逸。目录/文件权限保持私有。

测试：201 条触发压缩期间并发追加 202/203，重新读取后无重复或丢失；多实例/重连写入、断电式中断、损坏 JSONL 尾行、旧版迁移、写失败、超长记录。

### C2. 统一三后端会话与上下文预算 — ✅ 已完成

- [x] 当前 SessionStore 已覆盖 ZCode/Codex/OpenAI，继续以其为唯一用户可见历史来源，不再按后端维护不一致的 UI 历史。
- [x] 后端 remoteSessionId 绑定 backend + 实际 provider/model/endpoint + workspace + permission mode 等关键运行上下文；不把旧会话 ID 传给其他后端。恢复失败时提示并使用受预算限制的本地历史重新开始。
- [x] 后端切换时，如果继续使用同一个逻辑会话，要在新后端首次请求中注入最近的相关历史；不能复用已经落后的远端会话导致遗漏其他后端回合。可使用 revision 绑定远端会话，或明确失效后重建。
- [x] 当前 buildBudgetedContextMessages（protocol.js 347–366）按消息数/字符数截断，最新超大消息可超过上限。改成完整回合选择，保证 system prompt 和当前问题空间，预留输出预算；优先采用后端提供的 token/context 信息，缺失时使用保守估算。超长当前问题显式提示截断或拒绝，不静默丢失。
- [x] 区分原始文本、思考、工具摘要、错误、取消、截断状态。错误提示和 UI 警告不得写进发送模型的正文。默认不将隐藏思考与敏感工具结果重新发送给云端。
- [x] 无需向量数据库、RAG 或复杂长期记忆。更早历史可选摘要，默认轻量。

### C3. 流式事件规范与 SSE 完整性 — ✅ 已完成

现状：piClient.js text_snapshot（929–949）将非前缀快照作为 delta，UI 又 append；extension.js message_end（2712–2725）以 includes 合并，可能重复/漏掉修正内容。

- [x] 明确 text_delta、text_replace、thinking_delta、thinking_replace、message_final、tool_start/update/end、permission_request/resolved、turn_settled 事件及 ID。完整快照覆盖而非追加；最终权威消息与 SessionStore 完全一致。
- [x] 多条 assistant 消息/工具调用按 messageId 或明确的回合聚合协议处理；不要依据字符串 contains 猜测重复。
- [x] OpenAI SSE 按事件而非单行解析：支持 CRLF、空行分隔、多行 data、注释、网络分片、UTF-8；识别 [DONE]、finish_reason、usage、API error。兼容合法的非流式 JSON 回退；对未结束的 EOF 标为 interrupted，不能在正文附加网络警告。
- [x] 响应流所有路径（正常、失败、取消、超时、HTTP 非 2xx）显式关闭/取消并释放；所有 Gio 异步调用正确 finish，迟到结果不更新当前回合。
- [x] 非 SSE body、HTTP 错误体、模型列表、单条 JSONL、思考/工具输出设置可配置或合理字节上限。错误信息脱敏且截断。
- [x] /models 先检查 HTTP 状态，再解析结构；用户选定模型优先于列表第一个模型。未知/不支持 reasoning_effort 时不强制发送；支持模型能力配置。
- [x] 设置连接、首字、流空闲、总时长分离的超时策略；Agent 长工具执行与等待审批不能简单以无文字 120s 判失败。禁止对有副作用的 Agent 请求自动重试。

### C4. API Key 与隐私 — ✅ 已完成

现状：core/secretStore.js 60–104 吞掉 password_clear_finish 错误；单一 account 标识与 GSettings 明文回退。prefs.js 90–118 异步加载/延迟写入，需防旧保存覆盖新值。

- [x] Keyring lookup/store/clear 按真实返回值和错误处理；删除失败不得显示成功，不得下次重新读取已声称删除的旧值。库返回 false 的语义按实际 libsecret API 区分。
- [x] 默认不默默回退明文；Keyring 不可用时可仅在本次运行保留内存密钥，或经用户显式同意兼容存储。迁移成功再清除旧明文。
- [x] 按 endpoint/provider 配置独立密钥标识，规范 URL；切换 Base URL 不得把旧端点密钥自动发送给新主机。远程明文 HTTP 需要明显提示，仅允许用户主动配置；不得禁用 TLS 验证。验证跨域重定向时不会泄露 Authorization。
- [x] 密钥编辑使用版本号/串行写队列，过期异步加载不得覆盖新输入；关闭设置窗前正确完成保存或提示未保存。避免日志、命令行、错误通知暴露密钥。
- [x] 默认不自动发送选区、文件正文、窗口标题等桌面上下文；用户可预览、移除后才发送。后台通知默认仅显示状态，不显示敏感回答预览。
- [x] 保留清除当前历史/导出/隐私设置，明确本地会话包含哪些内容。

## 5. D：性能优化（P1）— ✅ 已完成

### D1. 真正增量 Markdown，而非仅 Actor 增量 — ✅ 已完成

现状：ui/markdownRenderer.js renderCardBodyIncremental（114–239）每次调用 parseMarkdownBlocks(rawText)，并检查所有冻结块签名；现有优点是复用 Actor，缺点是全量重复解析与长尾文本布局。

- [x] 保留已完成块 Actor 与复制按钮状态，新增流式解析器缓存已确认的块，按新增字符更新可变尾部。对 fenced code、未闭合 Markdown、跨 chunk 格式正确处理；收到 text_replace 或最终消息时允许必要的重解析。
- [x] 对超长代码块/正文使用批量更新、延迟高开销格式化；必要时流式纯文本、结束后完成渲染。不能改变用户可复制的原始内容。
- [x] Pango markup 严格转义；避免重复 parse_markup 和 set_markup，只有内容变化才更新。代码与普通文本可复制性保持可用。
- [x] 建立纯 JS parser 单测：各种 chunk 边界、中文、多字节、代码围栏、Markdown 注入、文本替换及最终输出与完整解析一致。

### D2. 渲染调度、工具轨迹、后台处理 — ✅ 已完成

现状：extension.js 2064–2119 文本刷新 48/75/110ms；dirty.tools 在 scheduleRender 中立即刷新；390–431 badge/后台刷新会扫描与更新样式。

- [x] 建立统一渲染调度器：首字及时、后续按时间与处理耗时批量更新；建议可见状态 50–100ms、长文/高负载 100–200ms。不要每个 token 更新 Actor、样式、滚动动画。
- [x] 工具事件合并更新，只对待审批/最终状态立即刷新；仅更新变更节点，不每次遍历全部工具圆点。
- [x] 面板隐藏时仅更新数据及必要的 badge，不做正文/工具布局；标记 dirty，恢复时按需批量刷新。状态相同不反复 remove/add style class。
- [x] 滚动更新合并至一次 idle/frame，用户手动向上浏览时保持锚点；长流式回答避免持续重启动画。
- [x] 限制消息/工具/思考缓冲字节数，UI 显示摘要或展开/复制完整内容；完整日志按隐私策略保存在磁盘。

### D3. Actor 数量与历史加载 — ✅ 已完成

现状：extension.js 首屏 24 条（1181–1259），后续全部加载或新消息增长没有 UI Actor 上限；每个助手卡片预创建大量工具详情组件。

- [x] 保留 24 条首屏，默认窗口约 40–60 条消息 Actor，可根据测量调整；超出窗口回收不可见旧 Actor，保持完整历史数据，按需加载恢复，确保选区/滚动锚点。
- [x] 工具详情和思考抽屉延迟创建，普通回答仅构建必要组件。大量工具轨迹分组或折叠，避免横向布局溢出。
- [x] 修复历史顺序：_prependOlderHistoryBatch 按原序插入 Actor，但 _cardList.unshift 反转内部顺序（2124–2132）。数据与 UI 顺序一致，重试通过 replyTo/messageId 绑定原问题。
- [x] 历史显示真实 createdAt/modelId；恢复历史时不要全部使用当前时间与当前模型。新建会话重置草稿/输入历史，避免跨会话泄露。

### D4. 主线程 I/O 与模型目录 — ✅ 已完成

现状：core/backendDetect.js 同步 file_get_contents/file_test/Dir.open；extension.js _populateModelPicker 每次打开重建；ZCode 每回合同步读取/写入 provider 配置。

- [x] 使用异步 Gio I/O 读取配置与模型缓存；CLI 检测结果、PATH/NVM 扫描、模型目录缓存并设置失效策略，必要时用文件监控/手动刷新。不要在面板打开关键路径同步扫描。
- [x] UI 先显示已缓存模型，后台异步刷新。模型目录可搜索/过滤/收藏近期模型，不固定只展示前 10 项且无法访问其他项。
- [x] ZCode 配置覆盖异步读取、生成、安全写入，缓存不含需要持久化的明文 Key；设置变更时失效。控制配置文件体积及 JSON 解析开销。
- [x] 若 GJS 主线程仍出现明显抖动，再考虑独立进程处理高开销任务；当前阶段不新增后台守护进程。

## 6. E：模块化、设置和 GNOME 集成（P1）

建议逐步从约 2900 行 extension.js、1070 行 piClient.js、1100 行 protocol.js 拆分，避免一次性大重写：

    core/
      chatController.js
      turnController.js
      sessionStore.js
      contextManager.js
      permissionPolicy.js
      secretStore.js
      backendRegistry.js
    backends/
      baseAdapter.js
      zcodeAdapter.js
      codexAdapter.js
      openaiAdapter.js
    runtime/
      processManager.js
      sseParser.js
    ui/
      dateMenuIntegration.js
      chatPanel.js
      messageCard.js
      modelPicker.js
      tracePanel.js
      markdownRenderer.js

- 接口统一：initialize/configure、getCapabilities、getModels、restoreSession、sendMessage(turn)、cancel(turnId)、respondPermission(request)、dispose。仅支持相应能力的适配器实现审批；事件规范与会话逻辑共享。
- BackendRegistry 独立管理三后端配置：executable、provider、model、reasoning effort、workspace/模式偏好；OpenAI 增加 base URL 和独立密钥。切换恢复上次所选配置，避免原模型污染另一后端。
- GSettings 变更批量提交、单次重连；设置拉取模型请求具有取消器及配置 generation，避免旧端点响应覆盖新端点。显示实际连接状态/模型，而不是猜测。
- dateMenuIntegration.js mount/unmount（18–69、98–132）：采用事务式挂载与完整回滚，原生 messageList 被移除但 wrapper 尚未挂载也必须恢复。记录原 parent、index、visible、opacity、translation、样式等；不盲目强制原生可见性。兼容 GNOME 锁屏及原生通知状态变化。
- 尽量避免操作私有 layout_manager._frozen；必须使用时记录/恢复且验证不会破坏 GNOME 自身分配。无法嵌入时可选独立 PanelMenu.Button 回退；失败时保留原生日期菜单并提供诊断，不导致整个 Shell 异常。
- extension.js disable：移除所有 signal、timeout、idle、动画、快捷键，清理 actor 引用；enable 失败也完整回滚。Clipboard 回调、异步 keyring、历史分页滚动回调需 generation 与锁屏检查；不得在卸载后或新生命周期操作旧 Actor。
- install.sh 当前 rm -rf dest 再 mv staging 并非原子替换：增加锁、同文件系统暂存、旧版本备份、失败回滚、实际启用结果提示。避免修改用户其他扩展状态。
- uninstall.sh --purge 清理本扩展 GSettings（在 schema 可用时）、数据目录、XDG_RUNTIME_DIR 与 XDG_CACHE_HOME 回退目录及本扩展专属 Keyring 项；删除失败报告失败。普通卸载保留历史；不删除外部 CLI 数据。不要用过宽属性清除其他应用凭据。
- 保持 metadata、README、docs、package.json 版本和打包内容一致；CI 验证标准包文件清单与 schema。需要 GNOME 50 实际支持证据，不盲目添加其他 Shell 版本。

## 7. F：功能增强（P2，稳定后执行）

以下功能是产品建议，逐项实现，不需要引入大型应用框架。

1. **快捷动作**：复用现有 QUICK_PROMPTS，增加可编辑模板及 / 命令（解释、翻译、润色、总结、代码检查、报错分析、学术润色），支持快捷键操作；默认仅填入输入框，不自动发送。
2. **上下文附件**：剪贴板内容独立引用而非静默截断到 4000 字符并覆盖草稿。支持多个文本引用、Nautilus 用户主动选中文件路径/文件内容、终端用户选中日志。展示来源、大小、预览和移除入口；云端发送前明确范围，文件大小限制及二进制类型处理。Wayland 不尝试无授权读取别的窗口内容。
3. **消息操作**：重新生成使用原问题与相应历史位置，不重复追加用户消息；继续生成针对 partial/length 截断；允许编辑问题、复制回答、导出当前对话。后端原生 resume 不支持回退时，新建后端运行会话并重建上下文，不能伪造历史回滚。
4. **轻量会话恢复**：只提供当前会话、新建、恢复上一个会话、导出、删除；保留有限数量/时间的旧会话，清理需明确策略与用户同意，不增加大型多会话侧栏。
5. **后台状态通知**：等待审批、任务失败、回答完成三种事件；点击返回对应任务（若仍存在），默认不展示敏感正文；限频去重。锁屏不暴露 transcript。
6. **智能模型选择（可选）**：本地规则按简单问答/文件读取/复杂代码/深度推理推荐用户配置的后端与模型。优先快速 OpenAI 问答，Agent 任务才推荐 ZCode/Codex。不要额外调用模型进行每次路由；用户可覆盖；绝不自动开启 full 或扩大文件/命令权限。
7. **紧凑诊断页**：显示后端版本、实际模型、权限能力、桥接握手、连接错误、会话保存状态；复制脱敏诊断。主界面不添加大量解释性固定文本。

## 8. 测试与验收

### 自动化要求

现有 .github/workflows/ci.yml 只检查 Node 语法、GLib schema、纯 JS 协议和 TurnController；不能证明 GJS/GNOME Shell 实际运行正确。

- 保持并执行 npm test、node --check、glib-compile-schemas --strict --dry-run schemas、bash -n install.sh uninstall.sh pack.sh。
- 增加纯 JS 单测：配置迁移/后端能力、授权 collision、事件 snapshot/replace、SSE 分片/多行/EOF、上下文预算、回合隔离、历史顺序、流式 Markdown。
- 增加可注入 I/O 的 SessionStore 测试与 GJS/Gio/Soup 集成测试（临时目录、localhost mock HTTP、假 CLI）。单元测试验证真实生产代码而非复制逻辑。
- 假 CLI 模拟非零退出、迟到输出、多个并行审批、无完成标记、超时、取消及派生进程；模拟 ZCode bridge 未命中和未知协议版本。
- CI 可运行 GJS 无头测试时加入对应 job；真正 GNOME 50 / Wayland UI 测试使用实际桌面或受支持的嵌套环境。无法运行则在提交说明中明确待人工验收，不能声称已通过。

### 人工回归矩阵

| 场景 | 必须验证 |
| --- | --- |
| 三后端正常问答 | 真实模型正确，首字/完成/历史恢复 |
| ZCode 审批、交互式提问 | 允许、拒绝、取消、并行请求、未知工具 |
| Codex 沙箱 | 模式与真实权限一致，不宣传不支持的能力 |
| 网络异常 | 401/403/429/5xx、断流、SSE malformed、超时 |
| 会话 | 取消后发送 B、跨后端切换、201+ 条压缩、历史恢复、重试 |
| 生命周期 | 启禁 30 次、开关面板 100 次、锁屏解锁、主题、多屏 |
| 安装升级 | 旧配置迁移、失败回滚、正常卸载/彻底清理 |
| 隐私 | Keyring 不可用、清除失败、端点切换、通知脱敏 |
| 性能 | 30k 字符回答、高速 SSE、100 个工具事件、长历史、后台生成 |

### 性能目标（需要实测）

在 Ubuntu 26 / GNOME Shell 50 上记录禁用扩展、启用空闲、面板打开、流式生成、CLI 任务五种基线。记录 GNOME Shell CPU/RSS、Agent 子进程 CPU/RSS、首字延迟、UI 单次更新耗时（p50/p95）、Actor 数量、是否存在残留进程。不要把整个 GNOME Shell RSS 当成扩展独占内存。

初始建议：热面板可输入 ≤100ms（p95），扩展开启空闲 CPU 增量 ≤0.5 个百分点（采样定义清楚），无 CLI 短会话 RSS 增量目标 ≤20MiB，单次 UI 更新 p95 ≤8ms，长会话 Actor 数量有上界。这些不是实测保证；若未达标报告具体数据与瓶颈。网络/模型耗时单独统计。使用 pidstat、GNOME Shell journal 和内部仅开发模式计时；日志不包含 Prompt 或 Key。

## 9. 每阶段交付清单

- [ ] 列明已解决的任务编号及实际改动文件。
- [ ] 给出新增/修改测试与实际运行结果；失败或无法运行的测试明确列出。
- [ ] 保留安装/升级和旧会话的兼容性，说明迁移及回滚方式。
- [ ] 检查源码、文档、设置、打包与 CI 中的三后端支持一致。
- [ ] 提供安全、性能与 UX 的剩余问题，不宣称未实测的效果。
- [ ] 小步提交，提交说明包含修复原因及验收结果。

建议下一次 Coding Agent 从 A1/A2 开始，完成后依次处理 B1–B4 和 C1–C4。之后在真实 GNOME 50 环境验证性能，再进行 D/E/F。若最新代码与本审查基线不同，以当前源码为准，保留本指南的产品约束和验收目标。
