# Alu Dock — Agent 工程地图

## 产品状态

Alu Dock V0.1 已完成本机部署和用户签收；`v0.1.0` 是当前本地发布版本。它是本机单用户的受管 Pi 运行时工程底座：长期 Host 持有 Alu Dock 管理的 runtime、任务实例和副作用，SSH TUI 等客户端通过结构化控制面观察与控制。

能力真相以当前代码、类型和测试为准。当前裸 `aludock` 进入无 runtime 副作用、按 cwd 提供上下文的 Dock Hub；固定根菜单将 New、Continue、History、Pi Sessions 与 Leave 分层。Hub 在一次 alternate-screen 生命周期内呈现所有菜单，并只在菜单可见时启用 Hub click/wheel tracking；进入 Session Work 前先恢复 shell screen。Session Work 使用可流动 main buffer 与 terminal-native mouse，不提供 Alt+M 或 `/mouse` 模式。`-c`/`--continue` 显式执行 current-project smart-entry，选择最近的 active/reopenable 实例，没有则 New；显式 `new` 与 `attach TARGET` 直达 Session Work。磁盘 Pi sessions 通过独立 Resume/Adopt inventory 进入；显式 `open` 暂时保留旧 smart-entry。

V0.1 的“发布”仅指这个本地单用户项目已经部署并签收，不表示公开 npm 发布、远程服务或多用户承诺。Checkout 与本机已安装包仍可能在后续开发中不同；运行状态以 `~/.local/share/alu-dock` 中实际安装的 package 和 `aludock service status` 为准。

## UI 视觉主题合同

Alu Dock 的视觉身份只来自阿露原稿与既有阿露资产，不使用通用“科技终端”模板。canonical terminal palette 定义在 `src/tui/alu-palette.ts`：发色 `#69424e`、高光 `#976269`、金色 `#f6c147`、肤色 `#f4d8ce`、蓝紫 `#6c84cd`、粉色 `#dd7e9e`、暖白 `#e6e1f2`。整体应是暖梅紫/玫瑰/金色与偏紫的靛蓝/薰衣草色；蓝色必须偏紫、偏靛，不得滑向 cyan。

未经用户明确批准，禁止新增青、青绿、turquoise、teal、emerald 或霓虹科技蓝，尤其不得将它们用作 accent、success、selection 或默认交互色。成功可由符号、文字和层级表达，不需要套用绿色。`src/tui/theme.ts` 必须复用/派生 canonical palette，不得维护另一套任意色板。

对齐 stock Pi 只对齐成熟的信息架构、conversation 语义层级、分组、留白和折叠行为，不复制 Pi 配色，也不得把 assistant、thinking、compaction、tool execution/result 降维成同质的单行遥测日志。终端背景仍归用户所有；局部 surface 只能使用 canonical palette 派生的低亮度暖色或蓝紫色调。任何新颜色或全局视觉方向都必须先取得用户明确确认。

## 技术与结构

- Node.js `>=22.19.0`，TypeScript ESM。
- 当前 Pi runtime cohort 精确固定为 `@earendil-works/pi-coding-agent@0.81.1` 与 `@earendil-works/pi-tui@0.81.1`；生产代码只使用 package-root exports，且不得把 pi-tui 类型泄漏到 Host、Protocol 或 Core port。
- Managed production Host 从 `~/.local/share/alu-dock` 安装包的本地依赖加载 Pi SDK，不调用 `$PATH` 中的全局 `pi`。Pi cohort 升级必须显式同步改动 exact pins、adapter 与门禁；不得顺带升级、重启或移除独立的全局 Pi/RPC 服务。
- Managed Host 面向 `systemd --user`；开发模式使用独立 dev socket。

```text
cli / Hub / Session Work tui
           │
           ▼
   DockClient / Protocol V2
           │
           ▼
 DockHost ── DockRegistry / catalog
           │
           ▼
     ManagedInstance
           │ RuntimeSession port
           ▼
       Pi adapters
```

依赖方向：`cli|tui → control → core ports/DTOs ← pi adapters`。Core 与 TUI 不得依赖 Pi runtime 对象。

## 按任务进入

| 任务范围 | 先读 |
|---|---|
| Protocol、Host dispatch、DockClient、CLI、catalog | [`docs/agent_maps/control.md`](docs/agent_maps/control.md) |
| ManagedInstance、Pi adapter、session replacement、settings、Extension UI | [`docs/agent_maps/runtime.md`](docs/agent_maps/runtime.md) |
| 当前 interactive flow、目标 Hub、Session Work、history/tree/queue/activity | [`docs/agent_maps/tui.md`](docs/agent_maps/tui.md) |
| systemd、managed startup、durable lifecycle、本地安装 | [`docs/agent_maps/deployment.md`](docs/agent_maps/deployment.md) |
| 测试选择与门禁 | [`docs/qa.md`](docs/qa.md) |

Managed 安装或运维另读 [`docs/local-install.md`](docs/local-install.md)。从对应 map 列出的入口、直接依赖与测试开始；只有这些材料不足时才扩大读取范围。

## 跨模块核心合同

1. **Host 唯一持有 Dock runtime。** Alu Dock 管理的 Pi runtime、extensions、tools、admission、run Promise 与副作用都属于 Host；客户端只消费控制面，不得成为第二 runtime owner。
2. **身份不可混用。** Dock `instanceId`、Pi `sessionId/sessionFile` 与 `runtimeGeneration` 表示不同生命周期；session replacement 保留 Dock instance 并推进 generation。
3. **控制面保持封闭。** Wire major 是 `2`；request/result/event 必须是有界、closed、JSON-safe schema，不传 runtime 对象、handler、component、binary、image bytes、data URI 或 raw base64。
4. **信任先于构造和副作用。** Project trust 必须在目标 runtime、project resources、extension hooks、teardown 或 catalog mutation 之前确定。
5. **Catalog commit 是可观察边界。** Required commit 完成前不得发布对应 success、snapshot 或 event；durable catalog 只保存身份、session metadata 与保守 intent，不保存正文、interaction、event log、queue 或 Promise。
6. **Host loss 不触发隐式恢复。** 不自动恢复或重放 prompt、queue、interaction、Promise 或 tool effect；显式 reopen 是新 generation 的 fresh transaction。
7. **不把不确定副作用当成失败重试。** Mutation 不自动 retry；传输丢失或 post-effect 不确定必须保留原 operation identity，并以不确定结果呈现。
8. **普通客户端入口不拥有 service 生命周期。** Hub、`-c`、`open`、`new`、`attach` 只连接既有 Host，不得隐式 install、start、restart 或 fork detached Host。
9. **Hub inventory 不等于 runtime。** `session.inventory` 只读取 bounded Pi session metadata；只有用户选择 New、Continue、History 中的 saved-session continuation、Resume、Adopt 或 Attach 后才允许进入对应 mutation/Work 路径。History 的 Forget 只删 Dock record，不删 Pi session。
10. **外部 Pi 可共存，但 session owner 唯一。** 独立的全局/standalone Pi runtime 拥有自己的进程与服务生命周期；它可与 Dock 共用当前 `~/.pi/agent` 认证、settings、extensions、skills 和 session 存储，但同一 Pi session file 绝不能被两个 runtime 进程并发打开或续写。

模块内的状态机、UI、settings、deployment 与测试细节以对应 agent map、代码和测试为准，不在顶层重复定义。

## 测试与安装入口

按 [`docs/qa.md`](docs/qa.md) 选择与改动匹配的最窄检查；Markdown-only 改动的入口是 `git diff --check` 与链接/路径核对。

Managed service 操作和本地安装合同见 [`docs/local-install.md`](docs/local-install.md)。测试与安装彼此独立；未经明确授权，不运行真实 Pi/model smoke、不执行 `npm run install:local`，也不重启 service。
