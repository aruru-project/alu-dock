# Core Runtime 与 Pi Adapter 图谱

## 适用范围

ManagedInstance状态机、RuntimeSession port、Pi SDK adapter、session replacement、tree、compaction、settings、Extension UI、Git workspace projection、tool result normalization。

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
| `src/core/tool-result-presentation.ts` | built-in details白名单、preview direction与control-frame fallback | runtime/protocol/TUI测试组 |
| `src/core/managed-instance.ts` | lifecycle、admission、queue、mutation transaction、generation、event/state唯一owner | `managed-instance` |
| `src/core/session-tree.ts` | runtime tree validation/projection、binary safety、generation-bound revision/pagination | `session-tree`, Pi tree tests |
| `src/core/extension-ui-broker.ts` | bounded text interaction、widget viewport/render bridge、controller lease、timeout/cancel/tombstone | `extension-ui-broker` |
| `src/pi/create-pi-instance.ts` | trust之后的runtime composition、安全reopen、ManagedInstance构造 | Pi reopen/stage tests |
| `src/pi/session-inventory.ts` | runtime-free session metadata index；header/name增量扫描与可重建cache | `pi-session-inventory`, `dock-control` |
| `src/pi/pi-runtime-host.ts` | 唯一生产Pi runtime adapter、session binding、Git observer lifecycle与replacement | `pi-runtime-host`, Pi real tests |
| `src/pi/git-branch-observer.ts` | trust后Host-owned Git branch cache、worktree/reftable watches、bounded shell-free refresh | `git-branch-observer` |
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
  owns: concrete Pi SDK objects, active AgentSession binding, resources/settings bridge,
        current-binding Git observer and stale-callback fence

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
- 每个active/staged binding拥有独立Git observer；promotion把candidate branch作为`session.replaced` generation bootstrap，旧binding同步关闭watcher并fence callback。Git branch不进durable catalog。
- Extension可在`agent_settled`后触发无client command ID的follow-on run（例如Sol guard compact后续跑）。它使用closed `run.started` identity `runtime-initiated`，仍完全由Host持有；fresh attach必须恢复其未完成tail，client detach/attach/read不得成为启动条件。
- Pi会先await Extension的`agent_settled` handler、再向runtime subscriber发布`agent_settled`；handler内启动的`ctx.compact()`因此可能先发布`compaction_start`。已建立的compaction boundary必须保持`execution: running`与ephemeral snapshot `compacting: true`直到`compaction_end`，后到的run settlement只结算旧run，不得把instance降为idle；`compacting`不进入durable catalog。
- `isCompacting`与`isStreaming`是独立维度。普通输入在compaction期间由对应`ManagedInstance`以`host_deferred`持有，保留原operation/queue-item identity与FIFO，不调用`AgentSession.prompt()`；attach/dequeue仍可见。最终`compaction_end`后首条按stock Pi语义启动fresh prompt，其余进入同一Pi session queue；`willRetry`时全部通过public steer/follow-up queue进入retry turn。preflight definite failure恢复为可dequeue，post-accept ambiguity不重试、不跨generation、不持久化，Host loss后也不replay。

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
| Git branch/footer context | `git-branch-observer.ts`, `pi-runtime-host.ts` | Managed snapshot/event、Protocol capability、TUI footer、normal/worktree/detached tests |
| Extension UI / widget | `extension-ui-broker.ts` | Pi adapter、Protocol interaction、Work widget surface与TUI dialog |
| tool telemetry classification | `pi-tool-result-normalizer.ts` | real extension result shape、normalizer tests |

## Pi API规则

- 生产Host只从`~/.local/share/alu-dock`安装包的exact-pinned依赖加载Pi SDK，不调用`$PATH`中的全局`pi`；只从`@earendil-works/pi-coding-agent` package root导入生产API，禁止private subpath。
- `pi-coding-agent`与`pi-tui`作为一个cohort显式升级：先核对跨越版本的breaking notes，在隔离checkout同步改exact pins与adapter，再通过typecheck、完整测试、no-model real Pi和PTY；安装仍由外层显式执行`npm run install:local`，目标model smoke需单独授权。不得把Dock升级自动扩展成全局Pi/RPC服务升级。
- Standalone/global Pi可拥有独立runtime并与Dock共享当前`~/.pi/agent`资源目录；同一个Pi session file不得被两个runtime进程并发持有或写入。
- 没有public API的行为明确defer，不通过内部字段或直接编辑Pi JSON伪造。
- Settings沿用Pi native snapshot、lock、field merge与last-writer-wins语义。
- Setting mutation固定：public setter → `await flush()` → `drainErrors()`。
- `compaction.reserveTokens`与`compaction.keepRecentTokens`在Pi提供public setter前只读。
- Extension exact registered command先由当前generation runner分类，保持`delivery:"prompt", queued:false`；unknown slash、skill、template仍走Pi-native prompt语义。
- Manual compaction intent一旦进入`configurationKind:"compaction"`，普通prompt admission即属于Host compaction Queue custody；不能等待Pi的`compaction_start`才开放Queue。pre-start消息不得提前drain与`session.compact()`竞争；manual mutation结束且runtime不再compacting后再恢复fresh dispatch。
- Nonzero subagent child exit必须成为model/history/TUI都可见的真实tool error。
- `pi install`、`pi config`与`pi login`仍由原Pi CLI负责。

## Projection bounds 与恢复语义

- Config inventories必须先确定canonical membership，再由adapter/Core按最多2,000项及control-envelope字节预算裁切；高基数tool registry扫描完整集合计数，但只用bounded max-heap保留canonical prefix，不复制/排序全catalog。`total`/`truncated`或resource/diagnostic独立 completeness metadata必须一路传到Protocol/TUI；adapter若先裁切，Core不能二次裁切后声称完整。
- Runtime structured JSON 使用depth 8、object key 100、array item 200、2,000 projected nodes、256 KiB aggregate预算和最多200条omitted paths；一条completed message再受512 KiB content预算。Pi built-in tool text与display diff在正常范围内原样进入Core；Dock不再施加8,000字符的第二层显示裁剪。只有接近1 MiB control-frame上限的结果才使用256,000字符transport fallback，并明确保留Unicode边界与裁切提示。
- `bash/read/edit/write/grep/find/ls`使用统一`BuiltInToolPresentation`：只投影preview direction、truncation/limit/continuation/full-output notices与成功`edit`的display diff。Pi adapter在runtime event与history边界删除raw details；`patch`、`firstChangedLine`、truncation内的重复content、unknown/private字段与binary/data URI不得进入Core/Protocol。可识别的有效字段独立保留；未知或畸形optional metadata不能让有效tool text或display diff整块消失。失败结果始终保留authoritative error text，不采用success diff；live与reattach history使用同一projection。
- Admission catalog commit期间的runtime handoff保留最新1,000-event tail；发生overflow必须发布显式extension error并刷新authoritative history/metrics，不能继续声称事件流完整。涉及该路径的改动必须验证最终queue/run状态，而不只验证错误字符串。
- Session metadata inventory逐root/directory/file报告bounded scan diagnostics；JSONL仍是authoritative，cache write/load失败不能把cache升级为真相源。
- Extension widget仍最多200行、每行8,000字符，同时受256,000字符aggregate预算；超限整个widget拒绝并发布`extension.error`，不静默显示前缀。
- Session tree采用complete bounded topology：100,000 node为接受边界，100,001明确失败；当前分页发生在完整projection之后。标准边界测试在本机约0.3秒完成，但超过此界限的Tree在V0.1不可用，不能自动丢节点伪装为完整树。

## 默认不读

- Pi安装目录、`node_modules`实现或上游源码：仅当public API合同无法由`.d.ts`和官方docs确认时读取。
- `src/tui/*`：除非closed event/DTO改变。
- deployment代码与Git历史中的验证证据。
