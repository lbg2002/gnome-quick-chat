<div align="center">

# ✦ Quick Chat · 随问 (`gnome-quick-chat`)

**专为 Ubuntu 26.04 / GNOME Shell 50 打造的系统通知栏原生 AI 随问与轻量 Agent 助手**

[![GNOME Shell](https://img.shields.io/badge/GNOME_Shell-50-4a86cf?logo=gnome&logoColor=white)](https://www.gnome.org/)
[![Ubuntu](https://img.shields.io/badge/Ubuntu-26.04_LTS-E95420?logo=ubuntu&logoColor=white)](https://ubuntu.com/)
[![Backends](https://img.shields.io/badge/Engines-ZCode_%7C_Codex_%7C_OpenAI_API-2ec27e)](#3-三大智能后端与能力矩阵)
[![Tests](https://img.shields.io/badge/Unit_&_State_Tests-Passed-success)](#8-模块化架构开发与测试)
[![Interactive Demo](https://img.shields.io/badge/▶_在线交互式动画演示-1080p_60fps-f5a623)](https://lbg2002.github.io/gnome-quick-chat/)

点击屏幕顶部中央的「时间 / 日期」（或按下全局快捷键 **`Super + Shift + Q`**），即可在通知栏左栏无缝切换 **「✦ 随问 | 通知」**，右侧原生日历与世界时钟保持原样。  
纯原生 `GJS` / `St` / `Clutter` 构建，**零 WebView 内存开销**、**增量流式 Markdown 渲染不阻塞 GNOME Shell 主线程**，支持**面板内一键切换模型/思考强度**、**剪贴板随问 (`Super + Shift + Y`)**、**横向彩色小圆点轨迹**与**按命令/域名/文件范围隔离的分级工具审批**。

<br/>

<a href="https://lbg2002.github.io/gnome-quick-chat/" target="_blank">
  <img src="docs/assets/intro-showcase.gif" alt="Quick Chat · 随问 12 页架构与特性介绍动画（点击打开 1080p 交互式播放器）" width="98%"/>
</a>

<sub>🎬 <b>12 幕架构与交互全览动画</b> · 点击上方动图或访问 <a href="https://lbg2002.github.io/gnome-quick-chat/"><b>在线 1080p 60fps 交互式播放器</b></a>（支持进度条拖拽、<code>←/→</code> 翻页、<code>Space</code> 暂停与 <code>F</code> 全屏演示；本地源码：<a href="docs/index.html"><code>docs/index.html</code></a>）</sub>

<br/><br/>

<details>
  <summary><b>🖼️ 展开查看高清矢量界面结构总览图 (SVG)</b></summary>
  <br/>
  <img src="docs/assets/hero-overview.svg" alt="Quick Chat · 随问 界面总览" width="96%"/>
</details>

</div>

---

## 目录

1. [核心特性一览](#1-核心特性一览)
2. [横向彩色小圆点轨迹与分级工具审批](#2-横向彩色小圆点轨迹与分级工具审批)
3. [三大智能后端与能力矩阵](#3-三大智能后端与能力矩阵)
4. [真实桌面运行实拍](#4-真实桌面运行实拍)
5. [桌面流畅性、会话状态机与安全边界设计](#5-桌面流畅性会话状态机与安全边界设计)
6. [快速安装、打包与配置指南](#6-快速安装打包与配置指南)
7. [全局快捷键与交互技巧](#7-全局快捷键与交互技巧)
8. [模块化架构、开发与测试](#8-模块化架构开发与测试)

---

## 1. 核心特性一览

* **⚡ 面向 GNOME Shell 进程级流畅性的增量流式渲染**
  * **冻结块增量 Markdown 引擎 (`ui/markdownRenderer.js`)**：流式输出时已完成段落与代码块固定不重建，仅原地刷新末尾活动块；长文多代码块回答零闪烁，流式中复制前序代码块的反馈状态不被打断。
  * **脏标记按需刷新 + 隐藏态零重排**：区分 `dirty = {text, thinking, tools}` 与动态节流间隔；当通知栏关闭或处于「通知」标签时自动暂停 UI 排版，仅在 `✦ 随问` 标签上点亮状态圆点并在重新打开时一次性刷新。
* **⌨️ 随手即达的桌面级快捷体验**
  * **全局唤醒 (`Super + Shift + Q`)**：在任意窗口一键呼出或收起通知栏随问面板并自动聚焦输入框。
  * **剪贴板 / 选中内容随问 (`Super + Shift + Y` 或面板 `📋` 按钮)**：自动读取系统剪贴板或主选区内容填入提问框，报错分析、翻译润色一步到位。
  * **面板内一键切换模型与思考强度**：点击随问状态栏模型名称（`▾`），无需打开设置窗口即可就地切换引擎、模型与思考强度（`默认 / 快 / 标准 / 深入`）。
* **🟢 横向彩色小圆点轨迹栏 (`Trace Dots`) + 确认式分级审批**
  * 将「深度思考」「工具调用」与「权限审批」浓缩为标题下方仅 20px 高的单行横向圆点：
    * **灰色小圆 (`●`)**：模型深度思考过程，点击展开/收起推理链路；
    * **橙黄小圆 (`●`)**：待审批或正在发送授权确认的工具调用；
    * **青绿小圆 (`●`)**：已确认送达授权或正在运行中的工具；
    * **翠绿小圆 (`●`)**：收到 `tool_execution_end` 真正执行完成的工具（点击查看参数与耗时）；
    * **红色小圆 (`●`)**：用户已拒绝或执行异常（含非零退出码）的工具调用。
* **🔐 严格的权限与配置安全边界**
  * **绝不篡改外部全局配置**：只读解析 `~/.zcode/v2/provider_config.json` 与 `~/.codex/config.toml`；ZCode 模型覆盖仅通过 `$XDG_RUNTIME_DIR/gnome-quick-chat` 下权限 `0600` 的每轮独立临时文件注入，并在回合结束时自动清理。
  * **GNOME Keyring 按端点隔离加密存储**：自定义 OpenAI API Key 按规范化接口地址独立存入系统密钥环（拒绝静默回退明文，跨域重定向自动剥离鉴权头）。
  * **默认保守的分级权限边界**：Shell 命令默认仅本次放行（可选会话授权基于完整命令 + 规范化 `cwd` + 参数的 SHA-256 哈希，杜绝前缀截断碰撞）；文件授权校验 `realpath` 真实路径与符号链接边界；未知工具与高危操作强制禁止会话级授权。

---

## 2. 横向彩色小圆点轨迹与分级工具审批

<div align="center">
  <img src="docs/assets/trace-dots-interaction.svg" alt="横向彩色小圆点轨迹与折叠审批交互" width="96%"/>
</div>

| 圆点颜色 | 状态机阶段 | 鼠标悬停 (`Hover`) | 鼠标点击 / 状态流转 |
| :---: | :--- | :--- | :--- |
| **⚪ 灰色小圆** | `thinking` | 同行提示显示「思考过程（点击展开）」 | 展开/收起完整思考推理文本（折叠时流式追加不触发正文重绘） |
| **🟡 橙黄小圆** | `pending_approval` / `sending_approval` | 显示 `⚠️ 待审批: <工具名>` | 展开审批抽屉；展示完整命令、真实 `cwd`、路径与风险，校验 `requestId`/`turnId` |
| **🟢 青绿/翠绿** | `running` → `done` | 实时预览工具名与请求摘要 | 授权送达后先进入 `running`，待工具真实返回 `tool_execution_end` 后方转为完成态 |
| **🔴 红色小圆** | `denied` / `error` | 显示工具名与异常摘要 | 展开查看拒绝记录、退出码或错误详情 |

---

## 3. 三大智能后端与能力矩阵

在 `gnome-extensions prefs quick-chat@lbg2002.github.io` 设置面板中，根据当前生效后端自动同步真实能力说明：

| 后端引擎 | 工具执行 | 气泡内交互审批 | 多轮会话续接 | 思考流展示 | 权限与隔离实现 |
| :--- | :---: | :---: | :---: | :---: | :--- |
| **ZCode CLI** (`zcode`) | ✓ | ✓ (桥接权威校验) | ✓ (`--resume`) | ✓ | `zcodeBridge.cjs` 版本握手校验 + `setsid` 进程组回收 + `0600` 临时配置 |
| **Codex CLI** (`codex`) | ✓ | — (CLI 沙箱策略) | ✓ (`exec resume`) | ✓ | 原生 `read-only` / `danger-full-access` 沙箱，支持并发 `item.id` 与退出码追踪 |
| **OpenAI API** (`openai`) | — | — | ✓ (整轮预算裁剪) | ✓ (`reasoning_content`) | `Soup 3.0` 事件级 SSE 解析器（兼容 CRLF/分片/中断检测）+ 按端点 Keyring 隔离 |

> **跨后端无缝续接与诚实回退**：当在同一对话中途切换模型/引擎，或执行原地重新生成/编辑提问回退历史时，`SessionStore` 会自动失效过期的远端会话标识，并在下一轮按整轮预算精确重建本地上下文。

---

## 4. 真实桌面运行实拍

<table>
  <tr>
    <td width="50%" align="center">
      <img src="docs/assets/screenshot-agent-live.jpg" alt="ZCode 联网工具查询实时股价" width="100%"/>
      <br/>
      <sub><b>图 1：在 Ubuntu 26.04 通知栏中调用 ZCode 联网工具实时查询 A 股行情</b></sub>
    </td>
    <td width="50%" align="center">
      <img src="docs/assets/screenshot-markdown-code.jpg" alt="Markdown 与独立代码块渲染" width="100%"/>
      <br/>
      <sub><b>图 2：思考过程折叠、增量 Markdown 富文本排版与独立代码块一键复制</b></sub>
    </td>
  </tr>
</table>

---

## 5. 桌面流畅性、会话状态机与安全边界设计

<div align="center">
  <img src="docs/assets/architecture.svg" alt="Quick Chat 系统架构图" width="96%"/>
</div>

### 统一回合状态机 (`core/turnController.js`)

每一轮请求均拥有独立的 `TurnContext`（唯一 `turnId`、`clientGeneration`、`sessionId`、子进程组句柄与分级超时看门狗），严格遵循单次幂等结算：

```mermaid
stateDiagram-v2
    [*] --> starting: beginTurn()
    starting --> streaming: markStreaming()
    streaming --> awaiting_approval: enterApproval() 暂停看门狗
    awaiting_approval --> streaming: leaveApproval() 最后一个审批解决后恢复
    starting --> cancelling: cancelActiveTurn()
    streaming --> cancelling: cancelActiveTurn()
    awaiting_approval --> cancelling: cancelActiveTurn()
    cancelling --> cancelled: 幂等结算保留已生成内容
    streaming --> completed: 正常结束且退出码/完成标记有效
    streaming --> interrupted: 流提前断开 (EOF 无完成标记)
    streaming --> timed_out: 分级超时触发
    streaming --> failed: 异常 / 非零退出码
```

* **彻底杜绝取消后串流**：停止请求 A 后立即发送请求 B 时，A 的延迟回调、stderr、旧定时器与审批响应均因 `turnId` 不匹配被丢弃，绝不污染请求 B。
* **流式增量 Markdown + 窗口化 Actor 回收**：`StreamingMarkdownParser` 仅增量解析尾部可变块；`HistoryWindowController` 控制挂载 Actor 数量上限，按需分页加载与回收。
* **无竞争快照会话存储 (`core/sessionStore.js`)**：入队捕获不可变快照，先提交 `messages.jsonl` 再更新 `meta.json`，损坏行隔离保存而不覆盖唯一历史副本。

---

## 6. 快速安装、打包与配置指南

### 环境要求

* **桌面环境**：Ubuntu 26.04 LTS（或搭载 **GNOME Shell 50** 的 Linux 发行版）
* **基础依赖**：`gjs`、`glib-compile-schemas`、`gir1.2-soup-3.0`（Ubuntu 26.04 默认已预装）
* **智能后端（三选一即可）**：`ZCode CLI`、`Codex CLI`，或任意 **OpenAI 兼容 API 地址**

### 原子化一键安装

```bash
git clone https://github.com/lbg2002/gnome-quick-chat.git
cd gnome-quick-chat
./install.sh
```

> `install.sh` 使用文件锁、同分区暂存目录编译校验与旧版本自动回滚保护。Wayland 会话下首次安装或升级扩展代码后，请**注销并重新登录一次桌面**生效。

### 生成标准 GNOME 扩展压缩包

```bash
./pack.sh
# 输出：dist/quick-chat@lbg2002.github.io.shell-extension.zip
```

### 打开设置与诊断中心

点击随问面板右上角的 **「⚙」** 按钮，或在终端执行：

```bash
gnome-extensions prefs quick-chat@lbg2002.github.io
```

---

## 7. 全局快捷键与交互技巧

| 操作 / 快捷键 | 功能说明 |
| :--- | :--- |
| **`Super + Shift + Q`** | **全局呼出 / 收起**通知栏「✦ 随问」面板并自动聚焦输入框 |
| **`Super + Shift + Y` / `📎`** | **上下文附件引用**：将剪贴板长文本、终端报错日志或 Nautilus 复制的文件作为独立附件芯片挂载（不截断、不覆盖草稿，支持预览/切换仅路径/移除与云端发送范围提示） |
| **输入 `/` 或按 `Ctrl + /`** | **快捷命令面板**：快速填入 `/explain`、`/translate`、`/polish`、`/summarize`、`/review`、`/error`、`/academic` 及自定义模板（默认仅填入输入框，不自动发送） |
| **点击状态栏模型名 (`▾`)** | 展开面板内**快速切换栏**（支持搜索过滤、常用收藏及切换引擎/思考强度） |
| **消息操作 (`↻` / `⇥` / `✎` / `⎘`)** | **原地重新生成**（不重复追加提问）、截断回答**继续生成**、**编辑原提问**重新分支、一键复制回答 |
| **顶栏会话菜单 (`⋯`)** | 轻量**新建会话**、**恢复上一个会话**、**导出当前对话 (Markdown)** 与**删除当前会话** |
| **`Enter` / `Shift + Enter` / `Esc`** | 发送当前问题 / 输入框换行 / 安全中止当前回合 |

---

## 8. 模块化架构、开发与测试

项目按职责拆分为 GNOME Shell 视图层、核心状态与策略层、三后端适配器层与运行时传输层：

```text
.
├── extension.js               # GNOME Shell 扩展生命周期入口、全局快捷键、通知与面板事件编排
├── backendClient.js           # 统一后端门面（委托三后端适配器、SessionStore 与 TurnController）
├── protocol.js                # 协议事件归一化、能力矩阵、上下文整轮预算与 CLI 参数构建
├── zcodeBridge.cjs            # ZCode 无头模式权威权限桥接（版本握手 + 同源策略校验）
├── prefs.js                   # Libadwaita 三分页设置中心（模型与后端 / 界面与权限 / 脱敏诊断）
├── backends/                  # 统一接口三后端适配器 (baseAdapter / zcode / codex / openai)
├── core/                      # 纯 JS 核心引擎（零 GI 硬依赖，单测直接验证真实生产代码）
│   ├── chatController.js      # 连接合并、防抖重连、生命周期世代隔离与权限范围自动撤销
│   ├── turnController.js      # 每轮独立 TurnContext 状态机与幂等单次结算
│   ├── permissionPolicy.js    # GJS/CJS 共享 SHA-256 命令键、真实路径与网络来源权限策略
│   ├── sessionEngine.js       # 无竞争快照持久化、整轮压缩、原地回退、导出与保留策略规划
│   ├── sessionStore.js        # Gio 异步会话存储与旧版会话只读导入封装
│   ├── backendRegistry.js     # 三后端独立 Profile 配置隔离与事务写回
│   ├── backendDetect.js       # 异步 CLI 身份探测与带缓存的模型目录扫描
│   ├── secretStore.js         # 按端点隔离的 GNOME Keyring 读写与串行保存队列
│   ├── markdownParser.js      # 流式增量 Markdown 解析器（冻结块缓存 + 尾块增量解析）
│   ├── renderScheduler.js     # 自适应节流渲染调度器与窗口化历史 Actor 控制器
│   ├── quickActions.js        # 可编辑快捷动作模板与 `/` 命令匹配引擎
│   ├── attachmentManager.js   # 多文本/Nautilus 文件/终端日志上下文附件与二进制保护
│   ├── notificationPolicy.js  # 后台状态通知脱敏、锁屏屏蔽、限频去重与点击路由
│   ├── modelRouter.js         # 纯本地规则智能后端/模型推荐（零额外请求，禁自动开启高权限）
│   └── diagnosticsReport.js   # 白名单脱敏运行诊断快照与复制报告生成
├── runtime/                   # 进程树管理 (subprocessRunner) 与事件级 SSE 解析 (sseParser)
├── ui/                        # 原生 St/Clutter 视图组件 (dateMenuIntegration / chatPanel / messageCard / approvalCard / modelPicker / markdownRenderer)
├── schemas/                   # GSettings XML Schema 定义
├── tests/                     # Node.js 自动化测试套件（覆盖阶段 A–F 全部核心模块与假 CLI/HTTP 集成）
├── install.sh / uninstall.sh  # 带锁原子安装回滚与支持 --purge 精确清理的卸载脚本
└── pack.sh                    # gnome-extensions pack 标准打包脚本
```

运行语法检查、Schema 严格编译与全部自动化单元测试：

```bash
npm test
glib-compile-schemas --strict --dry-run schemas/
```

查看运行日志与内存监控建议：

```bash
# 查看随问扩展实时日志
journalctl --user -b -f | grep -Ei 'Quick Chat|quick-chat|gnome-shell'

# 观察流式长回答期间 gnome-shell 进程的 CPU 与 RSS 内存变化
pidstat -p "$(pgrep -n gnome-shell)" -u -r 1
```

卸载扩展：

```bash
./uninstall.sh           # 仅移除扩展，保留历史对话记录
./uninstall.sh --purge   # 移除扩展并彻底清理本地会话、临时文件与密钥环中的 API Key
```
