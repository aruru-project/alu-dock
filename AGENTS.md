# Alu Dock — Agent 工程指南

## 快速开始

1. 根据任务选择一张 [`docs/agent_maps/`](docs/agent_maps/) 模块图谱。
2. 只读图谱列出的入口、直接依赖和对应测试。
3. 代码、类型和测试不足以回答时，再扩大搜索范围。
4. 历史计划与验证证据通过Git、Kanban和release receipts追溯，不进入当前工作树。

## 技术栈

- Node.js `>=22.19.0`、TypeScript ESM。
- `@earendil-works/pi-coding-agent@0.80.6`；生产代码只用 package-root exports。
- `@earendil-works/pi-tui@0.80.6` 是 V0.1 临时 client toolkit，不得把其类型泄漏到 Host、Protocol或Core port。
- 单机、单 Unix 用户、SSH headless；managed Host由 `systemd --user` 持有。

## 系统结构

```text
cli / interactive composition
        │
        ├── Dock Hub / Session Work TUI ── DockClient
        │                                  │
        ▼                                  ▼
control protocol ── DockHost ── DockRegistry / catalog transactions
                                      │
                                      ▼
                               ManagedInstance
                                      │ RuntimeSession port
                                      ▼
                                PiRuntimeHost
                                      │
                         Pi public SDK / session JSONL
```

依赖向内：`cli|tui → control → core ports/DTOs ← pi adapters`。`src/pi/*`可以依赖Core；Core和TUI不得依赖Pi runtime对象。

## 模块图谱

| 任务范围 | 先读 |
|---|---|
| Protocol、Host dispatch、DockClient、CLI、catalog | [`docs/agent_maps/control.md`](docs/agent_maps/control.md) |
| ManagedInstance、Pi adapter、session replacement、settings、Extension UI | [`docs/agent_maps/runtime.md`](docs/agent_maps/runtime.md) |
| Hub/Work TUI、conversation、history、tree、queue、mouse、activity | [`docs/agent_maps/tui.md`](docs/agent_maps/tui.md) |
| systemd、managed startup、durable lifecycle、dogfood release | [`docs/agent_maps/deployment.md`](docs/agent_maps/deployment.md) |
| 测试选择与门禁 | [`docs/qa.md`](docs/qa.md) |

Managed发布或运维时额外读取[`docs/dogfood-deployment.md`](docs/dogfood-deployment.md)。

## 全局硬约束

1. Host是Pi runtime、extensions、tools、admission、run Promise和副作用的唯一owner。
2. Dock `instanceId`、Pi `sessionId/sessionFile`、`runtimeGeneration`不可混用。
3. Wire major为`2`；advertised request/result/event必须是bounded closed schema。Capability只能在实现和门禁通过后advertise。
4. Event identity是`(hostEpoch, instanceId, runtimeGeneration, sequence)`；replacement从`session.replaced` sequence 1开始新generation。
5. Mutation不自动retry。传输丢失或post-effect不确定返回`effect_unknown`和原operation ID；operation ledger只提供Same-Host dedup，不宣称cross-Host exactly-once。
6. Catalog commit是可观察边界；required commit前不得发布success、snapshot或event。
7. Project trust必须先于target runtime构造、project resources、extension hook、teardown和catalog mutation。
8. Host loss不恢复或重放prompt、queue、Promise或tool effect；explicit reopen是generation+1 fresh transaction。
9. Durable catalog只保存身份、session metadata和保守intent；不保存正文、interaction、event log或Promise。
10. Terminal-facing值过滤C0/C1；Protocol不传function、handler、component、binary、image bytes、data URI或raw base64。
11. Work TUI中的session new/resume/fork/clone可以replacement当前Pi session；Dock Hub操作managed instances，不能静默替换无关source instance。
12. 裸`alu-dock`进入按当前`pwd`提供上下文、无runtime副作用的Dock Hub；显式`new`和`attach TARGET`直达Session Work。磁盘Pi sessions只进入独立Resume/Adopt inventory。
13. Human CLI必须闭环：可见ID/name可直接用于推荐动作；prefix/name歧义fail closed；不适用lifecycle的动作不展示；raw JSON只属于machine surface。
14. 到1.0前是greenfield：直接替换当前合同，不加compatibility layer、migration、dual stack或legacy alias。
15. 不从本仓修改Pi、`alu-daemon`、Rails WebConsole、Redis bridge、Alubot、npm/git package cache或live release。

## 实施纪律

- 一个能力只有一个owner模块；入口文件只做composition和routing。
- 同一working tree保持一个writer；reviewer默认只读。
- 实现期间运行focused检查；完整capability slice结束后执行一次对应门禁。不要按字段重复完整gate。
- Settings成功路径固定为Pi public setter → `await flush()` → `drainErrors()`；没有public setter的字段保持只读。
- 仓库故意没有`.pi/settings.json`；不得重建旧compaction guard。
- TUI只消费closed DTO/event。Host内部事实只有在具有用户影响和可行动性时才进入conversation或warning。
- 人工验收前，实现者先检查80×24与120×40真实输出。

## 图谱维护

只有以下结构变化才更新对应agent map：

- 主要入口文件；
- 模块owner或依赖方向；
- runtime/request/event调用链；
- 单一数据源或持久化位置；
- 对应测试入口。

图谱不写任务状态、排期、release ID、测试累计数、实现过程或决策历史。
