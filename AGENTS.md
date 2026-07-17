# Alu Dock — Agent 工程地图

## 产品状态

Alu Dock V0.1 正在开发中。它是本机单用户的受管 Pi 运行时工程底座：长期 Host 持有 runtime、任务实例和副作用，SSH TUI 等客户端通过结构化控制面观察与控制。

能力真相以当前代码、类型和测试为准。当前裸 `alu-dock` 进入无 runtime 副作用、按 cwd 提供上下文的 Dock Hub；固定根菜单将 New、Continue、History、Pi Sessions 与 Leave 分层。`-c`/`--continue` 显式执行 current-project smart-entry，选择最近的 active/reopenable 实例，没有则 New；显式 `new` 与 `attach TARGET` 直达 Session Work。磁盘 Pi sessions 通过独立 Resume/Adopt inventory 进入；显式 `open` 暂时保留旧 smart-entry。

V0.1 候选已具备响应式 Hub/Work 阿露资产、branch-aware `/tree` 与分层 Work activity，但仍未完成最终统一真人验收和正式版本签收；当前 dogfood rollout 不得写成 V0.1 已发布或已签收。

## 技术与结构

- Node.js `>=22.19.0`，TypeScript ESM。
- Pi SDK：`@earendil-works/pi-coding-agent@0.80.6`，生产代码只使用 package-root exports。
- `@earendil-works/pi-tui@0.80.6` 是 V0.1 客户端 toolkit，不得把其类型泄漏到 Host、Protocol 或 Core port。
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
| systemd、managed startup、durable lifecycle、dogfood release | [`docs/agent_maps/deployment.md`](docs/agent_maps/deployment.md) |
| 测试选择与门禁 | [`docs/qa.md`](docs/qa.md) |

Managed 发布或运维另读 [`docs/dogfood-deployment.md`](docs/dogfood-deployment.md)。从对应 map 列出的入口、直接依赖与测试开始；只有这些材料不足时才扩大读取范围。

## 跨模块核心合同

1. **Host 唯一持有运行时。** Pi runtime、extensions、tools、admission、run Promise 与副作用都属于 Host；客户端只消费控制面，不得成为第二 runtime owner。
2. **身份不可混用。** Dock `instanceId`、Pi `sessionId/sessionFile` 与 `runtimeGeneration` 表示不同生命周期；session replacement 保留 Dock instance 并推进 generation。
3. **控制面保持封闭。** Wire major 是 `2`；request/result/event 必须是有界、closed、JSON-safe schema，不传 runtime 对象、handler、component、binary、image bytes、data URI 或 raw base64。
4. **信任先于构造和副作用。** Project trust 必须在目标 runtime、project resources、extension hooks、teardown 或 catalog mutation 之前确定。
5. **Catalog commit 是可观察边界。** Required commit 完成前不得发布对应 success、snapshot 或 event；durable catalog 只保存身份、session metadata 与保守 intent，不保存正文、interaction、event log、queue 或 Promise。
6. **Host loss 不触发隐式恢复。** 不自动恢复或重放 prompt、queue、interaction、Promise 或 tool effect；显式 reopen 是新 generation 的 fresh transaction。
7. **不把不确定副作用当成失败重试。** Mutation 不自动 retry；传输丢失或 post-effect 不确定必须保留原 operation identity，并以不确定结果呈现。
8. **普通客户端入口不拥有 service 生命周期。** Hub、`-c`、`open`、`new`、`attach` 只连接既有 Host，不得隐式 install、start、restart 或 fork detached Host。
9. **Hub inventory 不等于 runtime。** `session.inventory` 只读取 bounded Pi session metadata；只有用户选择 New、Continue、History 中的 saved-session continuation、Resume、Adopt 或 Attach 后才允许进入对应 mutation/Work 路径。History 的 Forget 只删 Dock record，不删 Pi session。

模块内的状态机、UI、settings、deployment 与测试细节以对应 agent map、代码和测试为准，不在顶层重复定义。

## 测试与发布入口

按 [`docs/qa.md`](docs/qa.md) 选择与改动匹配的最窄检查；Markdown-only 改动的入口是 `git diff --check` 与链接/路径核对。

Managed service 操作和 dogfood 发布合同见 [`docs/dogfood-deployment.md`](docs/dogfood-deployment.md)。未经明确授权，不运行真实 Pi/model smoke，不部署、不切换 release，也不重启 service。
