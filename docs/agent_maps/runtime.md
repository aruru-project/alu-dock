# Core Runtime 与 Pi Adapter 图谱

## 适用范围

ManagedInstance状态机、RuntimeSession port、Pi SDK adapter、session replacement、tree、compaction、settings、Extension UI、tool result normalization。

## 构造与运行调用链

```text
cli serve
  └── createPiProjectTrustCoordinator()
        └── DockRegistry resolves trust + canonical cwd
              └── createPiInstance()
                    ├── validate/open Pi session file (optional)
                    ├── ExtensionUiBroker
                    └── createPiRuntimeHost()
                          └── Pi public SDK objects
                    └── ManagedInstance(RuntimeSession port)

DockHost / session-command-service
  └── ManagedInstance serialized transaction
        └── RuntimeSession interface
              └── PiRuntimeHost
                    └── AgentSessionRuntime / AgentSession / SessionManager

Pi runtime event
  └── PiRuntimeHost binding token
        └── ManagedInstance projection + generation fence
              └── closed DockEvent / snapshot
```

## 文件owner

| 文件 | 唯一职责 | 主要测试 |
|---|---|---|
| `src/core/instance-dto.ts` | closed instance/history/tree/event/receipt DTO与bounds | `managed-instance`, `control-protocol`, TUI tests |
| `src/core/config-projection.ts` | settings/tools/resources/commands metadata合同 | `managed-instance`, `pi-runtime-host` |
| `src/core/runtime-session.ts` | Pi无关RuntimeSession port与typed runtime errors | runtime测试组 |
| `src/core/managed-instance.ts` | lifecycle、admission、queue、mutation transaction、generation、event/state唯一owner | `managed-instance` |
| `src/core/session-tree.ts` | runtime tree validation/projection、binary safety、generation-bound revision/pagination | `session-tree`, Pi tree tests |
| `src/core/extension-ui-broker.ts` | bounded text interaction、controller lease、timeout/cancel/tombstone | `extension-ui-broker` |
| `src/pi/create-pi-instance.ts` | trust之后的runtime composition、安全reopen、ManagedInstance构造 | Pi reopen/stage tests |
| `src/pi/session-inventory.ts` | runtime-free session metadata index；header/name增量扫描与可重建cache | `pi-session-inventory`, `dock-control` |
| `src/pi/pi-runtime-host.ts` | 唯一生产Pi runtime adapter、session binding与replacement | `pi-runtime-host`, Pi real tests |
| `src/pi/pi-settings-adapter.ts` | Pi native setting projection、validation、setter/flush errors | `pi-runtime-host` |
| `src/pi/pi-extension-ui-adapter.ts` | Pi ExtensionUIContext → ExtensionUiBroker text surface | extension UI tests |
| `src/pi/pi-tool-result-normalizer.ts` | subagent child failure/invalid telemetry → real tool error | `pi-tool-result-normalizer` |
| `src/pi/configure-pi-network.ts` | Pi settings驱动的HTTP proxy/dispatcher | `pi-network` |

## 状态owner

```text
DockRegistry
  owns: instance membership, hostEpoch, durable catalog projection

ManagedInstance
  owns: lifecycle/execution, admission, pending queue, active operation,
        runtimeGeneration, event sequence/history projection, replacement transaction

PiRuntimeHost
  owns: concrete Pi SDK objects, active AgentSession binding, resources/settings bridge

TUI
  owns only: viewport/search/focus/tool-fold/local transient UI state
```

Core不得import `@earendil-works/pi-coding-agent`。生产Pi对象不得离开`src/pi/*`。

## Mutation transaction形状

```text
validate/admit
  → required pre-effect catalog intent commit
  → Pi runtime side effect
  → refresh closed state
  → required post-effect catalog commit
  → publish event/result
```

若post-effect commit未知，使用原operation ID返回`effect_unknown`；若同operation已有明确完成证据，不得再把known failure伪装成ambiguity。Manual compaction 在调用前后比较 public SessionManager compaction entries：未新增entry的 `nothing_to_compact`、already-compacted、cancel 与明确provider failure映射为 closed typed failure；调用后出现新compaction entry再异常仍保持 `effect_unknown`。

### Work mutation admission

Admission按能力分类，不用command-name例外：

- **live**：session name、model、thinking、active tools，以及22个可写setting中的17个非run-sensitive key；它们仍串行通过configuration/catalog边界，但可与既有run和queue共存，不改写`activeCommandId`。同步`session_info_changed`必须归属于name operation，而非当前model command。
- **idle**：tree navigation、new/switch/fork/clone/reload；另有5个会改变当前agent loop、queue drain、retry或transport语义的setting：`autoCompaction`、`autoRetry`、`steeringMode`、`followUpMode`、`transport`。
- **run-preempting**：manual compaction；允许接管active run，但仍拒绝并发control mutation与未清queue。
- **run control / queue**：abort、stop、steer、follow-up和dequeue沿用各自状态机，不走configuration admission。

`compactionReserveTokens`与`compactionKeepRecentTokens`是其余2个setting key，因Pi尚无public setter而只读，不计入mutation admission。

## Session replacement

`new`、`switch`、`fork`、`clone`、`reload`都由ManagedInstance管理generation rollover；PiRuntimeHost只执行mechanism并rebind当前session。

```text
ManagedInstance replacement intent
  → PiRuntimeHost replacement
  → fence old binding
  → generation + 1
  → commit replacement state
  → session.replaced sequence 1
```

- Dock instance ID保持不变。
- previous Pi session file保持可恢复，不做隐式删除。
- branch-summary cancellation使用Pi公开`abortBranchSummary()`路径；不能假设agent abort覆盖它。
- Host loss后的reopen是Registry创建fresh runtime transaction，不恢复旧queue/Promise/tool effect。
- Extension可在`agent_settled`后触发无client command ID的follow-on run（例如Sol guard compact后续跑）。它使用closed `run.started` identity `runtime-initiated`，仍完全由Host持有；fresh attach必须恢复其未完成tail，client detach/attach/read不得成为启动条件。

## 常见修改路由

| 需求 | 从这里开始 | 随后检查 |
|---|---|---|
| lifecycle/admission/queue/stop | `managed-instance.ts` | catalog port、DockHost error mapping、managed tests |
| event/snapshot/history DTO | `instance-dto.ts` | Managed projection、Protocol parser、TUI reducer |
| `/tree` round-trip | `runtime-session.ts`, `pi-runtime-host.ts`, `core/session-tree.ts` | Managed navigation transaction、Protocol、`tui/session-tree.ts`、real tree tests |
| session new/resume/fork/clone/reload | `managed-instance.ts` | PiRuntimeHost binding、catalog replacement、generation tests |
| compaction start/completion/failure | `managed-instance.ts` | PiRuntimeHost compact、session-command service、operation attribution tests |
| model/thinking/settings | `config-projection.ts`, `pi-settings-adapter.ts` | Managed commit/event、settings TUI |
| resources/tools/commands | `pi-runtime-host.ts` | closed config DTO、startup/client smoke |
| Extension text UI | `extension-ui-broker.ts` | Pi adapter、Protocol interaction、TUI dialog |
| tool telemetry classification | `pi-tool-result-normalizer.ts` | real extension result shape、normalizer tests |

## Pi API规则

- 只从`@earendil-works/pi-coding-agent` package root导入生产API；禁止private subpath。
- 没有public API的行为明确defer，不通过内部字段或直接编辑Pi JSON伪造。
- Settings沿用Pi native snapshot、lock、field merge与last-writer-wins语义。
- Setting mutation固定：public setter → `await flush()` → `drainErrors()`。
- `compaction.reserveTokens`与`compaction.keepRecentTokens`在Pi提供public setter前只读。
- Extension exact registered command先由当前generation runner分类，保持`delivery:"prompt", queued:false`；unknown slash、skill、template仍走Pi-native prompt语义。
- Nonzero subagent child exit必须成为model/history/TUI都可见的真实tool error。
- `pi install`、`pi config`与`pi login`仍由原Pi CLI负责。

## 默认不读

- Pi安装目录、`node_modules`实现或上游源码：仅当public API合同无法由`.d.ts`和官方docs确认时读取。
- `src/tui/*`：除非closed event/DTO改变。
- deployment代码与Git历史中的验证证据。
