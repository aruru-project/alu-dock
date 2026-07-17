# Control、Protocol 与 CLI 图谱

## 适用范围

Protocol V2、Unix socket、DockClient、Host dispatch、managed instance目录、durable catalog、human CLI。

## 入口与调用链

```text
src/cli.ts
├── open/new/attach ──dynamic import──> src/interactive.ts ──> DockClient
├── list/help ──> src/cli-list.ts / src/cli-help.ts
├── create/status/events/prompt/... ──> DockClient
├── serve ──> DockRegistry ──> DockHost
└── service ──> deployment/user-service.ts

DockClient
  └── hello + one request / connection
        └── protocol parser
              └── DockHost.dispatch()
                    ├── DockRegistry: instance identity/catalog lifecycle
                    ├── session-command-service: session capability execution
                    └── ManagedInstance: runtime transaction/state
```

当前源码中，空argv由`src/cli.ts:parseGlobalArgs()`映射为`open`，再由`src/interactive.ts`选择或创建runtime。全局产品合同要求空argv进入无runtime副作用的Hub；修改默认入口时从这两个composition文件和CLI/PTY测试开始。

## 文件owner

| 文件 | 唯一职责 | 主要测试 |
|---|---|---|
| `src/cli.ts` | argv解析、human/machine command composition、serve/service入口 | `cli-cross-client`, `cli-help`, `cli-list`, `managed-mode` |
| `src/index.ts` | package public exports；新增外部API时显式审查 | build、SDK smoke |
| `src/version.ts` | Dock/Pi/catalog版本常量 | build、protocol/release tests |
| `src/cli-help.ts` | human help投影 | `cli-help` |
| `src/cli-list.ts` | human instance列表、可行动命令投影 | `cli-list` |
| `src/control/protocol.ts` | closed request/result/event schema、bounds、parser、capability表 | `control-protocol` |
| `src/control/dock-client.ts` | typed transport、hello negotiation、response validation、timeout；不持有runtime state | `dock-control`, `cli-cross-client` |
| `src/control/dock-host.ts` | private socket lifecycle、hello、dispatch composition、event streaming、fault drain | `dock-control`, `durable-host-process` |
| `src/control/session-command-service.ts` | `session.*` mutation执行、operation ledger衔接、trust/replacement结果 | `dock-control`, `operation-ledger` |
| `src/control/dock-registry.ts` | instance目录、create/reopen/forget/prune、catalog projection | `durable-registry`, `dock-control` |
| `src/control/operation-ledger.ts` | Same-Host operation dedup/conflict | `operation-ledger` |
| `src/control/project-trust.ts` | bounded challenge、decision与canonical cwd流程 | `project-trust` |
| `src/control/catalog-transactions.ts` | serialized commit、commit boundary、mutation-fault状态 | `catalog-transactions` |
| `src/control/durable-catalog-store.ts` | strict schema-1 load与atomic file replacement | `durable-catalog-store` |
| `src/control/catalog-reconcile.ts` | 无runtime的startup normalization | `durable-registry` |
| `src/control/json-lines.ts` | bounded JSONL framing | `control-protocol`, `dock-control` |
| `src/control/socket-path.ts` | managed/dev socket路径 | `ensure-host`, `user-service` |
| `src/control/ensure-host.ts` | client readiness probe；不得隐式拥有service lifecycle | `ensure-host` |
| `src/core/catalog.ts` | durable catalog DTO、invariants、typed commit errors | catalog测试组 |
| `src/core/instance-dto.ts` | snapshots、events、cursors、history、receipts的closed DTO | protocol/runtime/TUI测试组 |

## 请求修改顺序

```text
1. protocol.ts: request/result DTO + fail-closed parser + bound
2. dock-client.ts: typed method + result parser + correlation validation
3. owning service/registry/ManagedInstance: execution
4. dock-host.ts: only routing/composition
5. implementedCapabilities(): only after implementation exists
6. protocol + client/host integration tests
```

不要把capability business logic继续堆进`DockHost.dispatch()`。

## 常见修改路由

| 需求 | 从这里开始 | 随后检查 |
|---|---|---|
| 新request/capability | `protocol.ts` | `dock-client.ts` → service/registry → `dock-host.ts` |
| Human CLI command或TARGET解析 | `cli.ts`, `cli-help.ts`, `cli-list.ts` | `interactive.ts`, Registry lookup语义、CLI tests |
| attach/replay/follow | `dock-host.ts`, `dock-client.ts` | `instance-dto.ts`, `ManagedInstance.eventsSince()` |
| create/reopen/forget/prune | `dock-registry.ts` | catalog transaction/store、trust、durable tests |
| mutation ambiguity/dedup | `operation-ledger.ts`, `catalog-transactions.ts` | owning mutation、error mapping、cross-client tests |
| project trust | `project-trust.ts` | Registry preflight、Pi factory、CLI prompt |
| wire bounds或sanitization | `protocol.ts`, closed DTO owner | client result parser、fuzz/invalid tests |

## 必守边界

- Protocol payload只能包含closed JSON-safe DTO。
- 每个connection先hello，随后只允许一个request；event follow是该request的streaming结果。
- Mutations由caller operation ID关联，client不自动retry。
- Registry只在required catalog commit后publish instance或success。
- `forget`/`prune`只删Dock catalog record，不删Pi session file。
- `ensure-host.ts`只验证连接；普通open/new/attach不得导入deployment模块自动启动Host。
- Human CLI不直接输出raw protocol error JSON。
- Human CLI、Protocol V2 machine control与Pi-registered model tools是独立surface；Agent不得通过自身CLI形成self-loop。

## 默认不读

- `src/tui/*`：除非改human interactive flow。
- Pi package internals与`src/pi/*`：除非closed RuntimeSession port必须变化。
- Git历史中的计划/验证证据与`dist/`。
