# GNOME Shell 50 冻结专项调查

## 现场与基线

- 报告环境为 Ubuntu 26.04 LTS、GNOME Shell 50、Wayland、Quick Chat v0.3.5。用户报告点击「新对话」后 Shell 停止响应，鼠标指针仍能移动，窗口点击和系统快捷键失效。另一次在注销再登录后出现点击失效，禁用扩展后恢复。
- 现场安装的 Shell 软件包为 `50.1-0ubuntu1.5`，libadwaita 为 `1.9.1`。本轮使用这些已安装的库和内嵌源码做只读核对。
- 原工作树的 `main` 是 `4c72c52`（v0.3.1），Git 状态干净。GitHub Compare 确认其落后最新 `main` 80 个提交，未分叉。本地差异为 31 个文件。现有隔离工作树 `gnome-quick-chat-debug` 的 `fix/gnome50-freeze-local` 为 `fa50691`，状态干净，与 GitHub `main` 一致。使用现有分支，保留原工作树。Git 直接查询远端受默认网络限制，使用 GitHub Compare 核验。
- 用 `journalctl --list-boots --no-pager` 确定启动记录，再查 `journalctl --user -b -1 _COMM=gnome-shell --no-pager -o cat` 和系统 journal 对应 Shell 进程，补查 `-b -2`。匹配错误出现在 2026-11-20 14:11–17:10 JST 的 `-1` 启动周期。以下仅摘录错误类型和栈关系。

## 版本回归

| 发布快照 | 差异 |
| --- | --- |
| v0.3.3 `513a36b` | 已有 `stopClient()` 和按设置变化重连的路径。DateMenu 集成含避免替换原生消息列表的限制。 |
| v0.3.4 `1491ec9` | `7127720`、`bec6594` 引入只挂载扩展 Actor 的路径，扩展 Actor 与原生列并存。 |
| v0.3.5 `8cb81ca` | `1437e8c` 恢复左列双标签，移动原生消息列表。 `09629e5` 对内部会话写入跳过设置重连，延后历史重建。 `d067abe` 引入非模态胶囊，`511822c` 随后加入模态抓取，`6d752f3`、`ab694cb` 加锁屏和异常释放。 |
| 最新主线 `fa50691` | 阻止初始化完成前反复点击新会话。 |

版本对照使用本地发布提交，包含 v0.3.5 两个发布准备提交 `0745f91`、`8cb81ca`。

## 已确认的缺陷

### A. 新会话重连与历史刷新

- 路径为 `_newSession()` → 等待旧会话保存 → 写入 `session-id` 并停止旧连接 → 延迟启动 `_ensureClient()` → `ChatController.ensureConnected()` → `BackendClient.startAsync()`、`get_state`、`get_messages` → `_onClientStateReady()` → `renderInitialHistory()`。
- v0.3.5 基线用短期布尔锁识别内部设置写入。锁释放后到达的同一 ID 通知仍可排队重连。已有重连定时器也可跨越 `stopClient()`，再次销毁正在接续的连接。原有延迟任务经 `_scheduleIdle()` 在锁屏时被过滤，其清除切换锁的回调一并丢失。后两个问题可由 mock 调度重现。
- 新代码对比有效的会话 ID，忽略自身写入和重复通知，外部真实变更继续走防抖重连。停止连接同时撤销待执行重连、取消初始化。切换令牌及客户端代际隔离迟到保存、重连和启动结果。锁屏时撤销切换令牌，旧任务的完成回调只清理自己的令牌。
- 后端正常加载仅请求热历史副本，归档需另行分页。历史视图只在当前连接就绪时更新一次，删除旧卡片后直接渲染窗口，避免有历史时先创建空态卡片再销毁。 `backendClient.js` 的现有关闭、异步启动和分段归档接口足以支持修复。
- **待验证**：重复连接与 Actor 更新确实增加工作量。现场 journal 缺少冻结点的主线程栈和布局统计，无法将系统级冻结归因于无限重排、磁盘阻塞或特定后端。

### B. 登录和注销期间的 Actor 与输入

- `-1` 启动周期 16:58:53，注销路径的通知销毁触发计数回调。原生 DateMenu 的 `_sync` 访问已清理的 `_settings`，另外扩展的通知计数回调尝试写入已销毁的 `St.Label`。两条栈都经过 GNOME 消息源的计数更新。这证实了注销期间发生过过期回调。
- 16:59:16，新 Shell 进程记录胶囊初始化失败，`Object is of type St.Label - cannot convert to StScrollable`。本机 GType 检查确认 `St.BoxLayout` 实现 `St.Scrollable`，`St.Label` 未实现。旧代码将 Label 直接作为 `St.ScrollView` 子项，且初始化异常发生在正常展示路径的抓取调用之前。
- 安装的 Shell 50.1 `ui/main.js` 中，`Main.pushModal()` 调用 `global.stage.grab(actor)` 并维护模态计数和焦点栈。 `Shell.ActionMode.NORMAL` 是快捷键模式，不能把该调用变成只抓键盘的 API。旧胶囊的 `show()` 和点击入口包含该抓取。发现了系统输入受影响的机制，journal 缺少抓取遗留的现场证据。
- 删除胶囊中所有显式模态和 stage grab。默认关闭，首次调用才构建。快捷键限普通桌面模式，胶囊仅在顶端拥有自己的输入控件和普通焦点。发送、隐藏、锁屏和销毁都释放扩展自己持有的焦点，已转移到其他控件的焦点由其所有者保留。锁屏清理胶囊草稿和回答，销毁清理 Actor 引用、定时器及请求令牌。流事件按回合 ID 归属，隐藏时不排队刷新。
- **待验证**：真实 Wayland 客户端与 Shell 之间的快捷键聚焦、输入法、按键传递以及焦点恢复。现场日志不足以证明登录点击失效由旧胶囊抓取遗留引起。

### C. 日期菜单布局

- 使用 `gresource extract /usr/lib/gnome-shell/libshell-18.so /org/gnome/shell/ui/dateMenu.js` 核对本机 Shell。 `calendarArea` 是日期弹窗的横向盒，第一列为 `Calendar.CalendarMessageList`，第二列由 `CalendarColumnLayout` 管理日期和日历。日期弹窗的捕获阶段按钮、触摸和键盘事件直接委托给该消息列表判断是否折叠分组。 `_sessionUpdated()` 按通知能力和 greeter 状态更新其可见性，菜单打开时还会重置日历选中日期。
- 旧实现将消息列表迁入扩展 Actor，扩展标签逻辑与原生会话逻辑都能改同一 Actor 的可见性。正常情况下右列仍在原容器，但左列尺寸和事件路径已改变，部分回退失败还可能使扩展继续持有原生 Actor。删除重挂载及其信号监听。旧的 `auto` 和 `datemenu` 配置随运行时统一落到独立顶栏入口，配置和历史文件无需迁移。
- 原生左侧「通知 / 随问」双标签处于 **blocked** 状态。安全回退将通知及日历保留在日期菜单，聊天从独立顶栏按钮进入。恢复双标签需要独立 Shell 中验证事件传播、布局约束、锁屏以及卸载期间的所有权。

### D. 设置窗口

- Settings 改为短中文标题和简短说明，权限说明细节保留在提示中。ActionRow 和 ExpanderRow 使用一行标题、两行副标题，动态新建的快捷动作行同样设置限制。Provider 与模型下拉和选中项使用省略显示及完整名称提示。EntryRow 保留完整可编辑内容。设置窗口默认尺寸沿用基线。
- 独立 Broadway 显示上的真实 GTK/libadwaita 测试使用 540 px 窗口、长中文和连续标识符，验证实际分配宽度及省略状态。完整设置页在用户主题、分数缩放和不同字体下的逐页视觉核验仍为 **blocked**。

## 测试记录

| 项目与命令 | 实际结果 |
| --- | --- |
| `find . -type f \( -name '*.js' -o -name '*.cjs' \) -print0 \| xargs -0 -n1 node --check` | 通过，77 个文件 |
| `glib-compile-schemas --strict --dry-run schemas`、`bash -n` 分别检查安装、卸载和打包脚本 | 通过 |
| `npm test` | 通过，163/163。隔离 XDG 目录、内存 GSettings、清空显示及 D-Bus 地址，允许回环 mock 服务和测试子进程。默认受限执行时，相关 socket 和子进程测试报权限错误。 |
| `gjs -m tests/gjs_smoke.js` | 通过。隔离环境验证真实 GJS/Gio/Soup，使用回环 HTTP/SSE、ZCode bridge、假 CLI 及临时会话，不启动 Shell。 |
| `node tests/capsuleAndSessionGuard.test.js` | 通过，5/5。100 次新会话切换叠加连点、待执行重连、延迟设置通知，每次只启动一次连接并提交一次历史渲染请求。覆盖外部会话变化、锁屏、greeter、注销、模拟重新登录与迟到初始化。 |
| 同一专项测试的胶囊和独立顶栏场景 | 通过，100 次开关、模态入口禁止调用、保留外部焦点、单个流式定时器、销毁清理、原生日历与通知的父子链、独立面板卸载与注册失败回滚。使用模拟 St/Clutter。 |
| `gjs -c` 检查本机 Shell 50.1 的 GType | 通过。确认 `BoxLayout` 实现 `StScrollable`，`Label` 未实现。未创建 Shell Actor。 |
| `GDK_BACKEND=broadway BROADWAY_DISPLAY=:71 gjs -m tests/gjs_prefs_layout.js` | 通过。GTK 显示服务只监听临时 Unix 套接字，使用隔离 XDG 目录及内存 GSettings。四种实际控件在 540 px 下通过布局断言。 |
| GNOME Shell Wayland 活体 Shell 交互、CPU/RSS、布局耗时、真实后端 | **blocked**。本轮未建立满足独立显示、D-Bus、用户配置和进程隔离条件的测试 Shell。 |

## 稳定性影响与后续验收

胶囊使用有界 Actor 树，流式回答保留最近 10,000 个 UTF-16 代码单元，最多挂起一个 90 ms 合并定时器，回答区域限制为 260 px 和监视器高度三分之一以内。完整会话仍可通过展开查看。独立顶栏方案移除了扩展对系统通知计数和 DateMenu 布局的直接耦合。实机性能收益暂无采样数据。

下一步应在一次性 Ubuntu 26.04 虚拟机或已验证完全隔离的 GNOME Shell 50 Wayland 环境安装此分支，再逐项验证冷登录、锁屏解锁、注销、新会话重复点击、胶囊打开时点击其他窗口、输入法、滚动及多屏。用该测试环境的 journal 和独立进程采样记录帧时间、Actor 数、CPU 和 RSS。胶囊在验证完成前保留实验开关，原生双标签在独立布局验收前继续采用顶栏回退。

本轮未安装、启用或发布扩展，未向 GitHub 推送，也未修改当前桌面或真实 GSettings。

## 后续隔离实机安装验证

在本机安装包测试中启动了独立 GNOME Shell 50.1 / Mutter Wayland 进程。Bubblewrap 隔离了进程、挂载与网络命名空间，测试进程使用独立的用户目录、GSettings、D-Bus 和 Wayland 套接字。显示采用 1280×800 虚拟监视器与软件渲染，未接入当前桌面。

- 初次退出时捕获到 Quick Chat 的真实过期回调。Shell 已销毁面板 Actor，原生关闭阶段的嵌套 GLib 循环仍分派了延迟启动任务。调用栈从 `main.js` 的 shutdown 回调，经新会话的延迟任务和 `_ensureClient()`，最终访问了已销毁的状态标签。
- 面板的真实 `destroy` 信号现在撤销当前切换、停止客户端并取消剩余 GLib 任务，后续异步路径也会检查面板生命周期。正常禁用同样提前取消调度。新增 Node 回归覆盖面板先销毁、排队回调后分派的顺序。
- 修复包在独立 Shell 中通过 100 次新会话切换、100 次胶囊开关、流式标签渲染、普通焦点释放与保持外部 Actor 焦点、模态计数、原生日历与通知 Actor 的父子关系。还在新会话已排队时销毁真实面板，验证零残留定时器、零迟到渲染，测试 Shell 退出时未出现扩展 JS 错误或已销毁 Actor 访问。
- 当前桌面文件未升级或启用。本机物理输入设备、真实窗口跨应用点击、输入法、实体显示及 GDM 登录注销仍未验证。日期菜单左侧双标签继续使用独立顶栏回退。
