# Alu Dock 本机控制协议 V2

状态：阶段 0 冻结设计；阶段 1–6及V0.1 dogfood queue control已按 capability 实施

传输：当前 Unix 用户私有 AF_UNIX socket + UTF-8 JSONL

范围：单机、单 Unix 用户、一个 `systemd --user` Host

## 1. 协议不变量

1. Host 是 runtime、extension、run 和 tool 的唯一 owner；协议不转发 PTY 或 ANSI 屏幕。
2. 每条连接必须先完成 V2 hello。没有共同版本、Host 未 ready 或缺少 required capability 时，在任何业务 side effect 前失败。
3. 普通连接在 hello 后只执行一个 request；attach 连接在初始 response 后保持为单向 event stream。
4. 初始 response 必须先于 live event；Host 在生成 replay/snapshot 时暂存并排序同期事件。
5. `hostEpoch` 标识一个 Host process；`runtimeGeneration` 标识 instance 当前 Pi runtime/projection 世代。
6. Event cursor 的唯一域是 `(hostEpoch, instanceId, runtimeGeneration, sequence)`，不能跨任一维度复用裸 sequence。
7. Transport 断开只表示 mutation 结果未知；除明确标为 read-only 或同 epoch interaction ack 的操作外，客户端不得自动重试。
8. Pi session JSONL 是对话上下文权威；Dock catalog 不是 work queue，Dock event ring 不是 durable audit log。
9. Host loss 后 catalog 可以支持用户显式 reopen 对话 context，但永不 submit、恢复、重试或重放旧 prompt、queue、Promise 或 tool side effect。

## 2. 版本与 staged capability

wire major `2` 是当前项目的初始协议合同。1.0 前不建设旧协议兼容、迁移或双栈；非 V2 输入按当前合同统一拒绝。capability 名称中的 `.v1` 只是该 capability 自身的首版 schema，不代表存在旧 Host 包袱。版本维度必须分开：

- `protocolVersion`: wire major，初始为 `2`；
- `dockVersion`: Alu Dock package/build version，V0.1 改为 `0.1.0`；
- `catalogSchemaVersion`: durable catalog schema，初始为 `1`；
- `piSdkVersion`: pinned `0.80.6`；
- `hostEpoch`: 每次 Host process start 生成的新 UUID。

Capability 只在实现和对应 gate 都通过后才 advertised：

| 阶段 | 新增 capability |
|---|---|
| 1 | `core.v2`、`host.info`、`instance.catalog`、`events.follow`、`models.v1`、`tools.v1`、`settings.v1`、`resources.v1`、`session.core` |
| 2 | `tui.projection.v1`（完整 history/message/tool/metrics projection）、`run.abort.v1` |
| 3 | `session.commands.v1`（new/resume/name/compact/reload） |
| 4 | `extension_ui.v1` |
| 5 | `service.managed.v1`、`catalog.v1`、`session.reopen` |
| 6 | `session.tree.v1` |
| V0.1 dogfood #154 | `queue.control.v1`（ephemeral pending projection与显式dequeue/restore） |

默认 TUI hello 只 required `core.v2` 与其马上要调用的最小 capability；不能在阶段 1 要求阶段 5 的 `session.reopen`。每个 command 在调用前再次检查自己的 capability。

## 3. Wire limits

所有长度按 UTF-8 bytes 或明确的字符数验证；超限在 side effect 前拒绝。

| 名称 | 上限 |
|---|---:|
| JSONL record | 1 MiB bytes |
| request/operation/client/interaction ID | 128 chars |
| capability count/name | 128 / 128 chars |
| instance/session name | 256 chars |
| cwd/session/file path | 16,384 chars |
| prompt/editor text | 256,000 chars |
| title/status/error message | 2,048 chars |
| notification/tool text block | 8,000 chars per block |
| select options / option text | 200 / 8,000 chars |
| replay events | 1,000 |
| history/tree page items | 200 |
| models/tools/resources/commands per result | 2,000 |
| extension status keys | 64 per runtime generation |
| queued dialogs | 16 per instance |
| pending user queue | 64 items / 256,000 aggregate chars |
| generic JSON depth/keys/array | 8 / 100 / 200 |

分页/裁剪后的 response 仍必须小于 1 MiB。Protocol projection 不包含 Buffer、TypedArray、function、symbol、Component 或 binary/image bytes。

## 4. Hello 与 pre-ready errors

Client hello：

```json
{"kind":"hello","requestId":"h1","versions":[2],"client":{"name":"alu-dock-tui","version":"0.1.0","clientId":"uuid"},"requiredCapabilities":["core.v2","events.follow","queue.control.v1","run.abort.v1","tui.projection.v1","extension_ui.v1"]}
```

Ready success（capability 列表只是当前实现集合）：

```json
{"kind":"hello_ack","requestId":"h1","version":2,"host":{"pid":123,"dockVersion":"0.1.0","piSdkVersion":"0.80.6","hostEpoch":"uuid","startedAt":"2026-07-14T00:00:00.000Z"},"catalogSchemaVersion":1,"capabilities":["catalog.v1","core.v2","events.follow","extension_ui.v1","host.info","instance.catalog","models.v1","queue.control.v1","resources.v1","run.abort.v1","service.managed.v1","session.commands.v1","session.core","session.reopen","session.tree.v1","settings.v1","tools.v1","tui.projection.v1"],"limits":{"maxLineBytes":1048576,"maxPromptChars":256000,"maxReplayEvents":1000,"maxHistoryItems":200}}
```

任何 hello 失败都使用 closed `hello_error`，随后关闭：

```ts
type HelloError =
  | { kind: "hello_error"; requestId: string; error: { code: "invalid_hello"; message: string } }
  | { kind: "hello_error"; requestId: string; error: { code: "unsupported_protocol"; message: string; hostVersions: number[] } }
  | { kind: "hello_error"; requestId: string; error: { code: "capability_missing"; message: string; missing: string[] } }
  | { kind: "hello_error"; requestId: string; error: { code: "host_starting" | "host_draining"; message: string; retryAfterMs?: number } };
```

Starting listener 只回答 `host_starting` hello_error；draining listener 若尚未关闭只回答 `host_draining`。它们不发送普通 response。无法解析成 bounded hello 的输入直接得到 `invalid_hello`（若 requestId 可安全提取）或关闭。

Capabilities 是行为门禁，不是装饰 metadata。Host 返回排序、去重集合；missing capability 不能被当作 Host 不存在或触发第二个 Host。

## 5. 通用 envelope

Request：

```json
{"kind":"request","version":2,"requestId":"r1","type":"instance.list","params":{"includeTerminal":true}}
```

Response：

```json
{"kind":"response","version":2,"requestId":"r1","hostEpoch":"uuid","ok":true,"result":{}}
```

Error：

```json
{"kind":"response","version":2,"requestId":"r1","hostEpoch":"uuid","ok":false,"error":{"code":"instance_busy","message":"Instance is not quiescent","retryable":false}}
```

Instance event：

```json
{"kind":"event","version":2,"requestId":"attach-1","hostEpoch":"uuid","event":{"scope":"instance","sequence":17,"instanceId":"uuid","runtimeGeneration":3,"occurredAt":"2026-07-14T00:00:00.000Z","type":"run.settled","data":{"result":"succeeded"}}}
```

V0.1 不在 instance attach stream 中混入 Host/catalog events。Host readiness/drain/reconcile 通过 hello、`host.info`、systemd state 和 journal 观察；因此所有 V2 event 都有 instance ID/runtime generation。

Envelope、每个 advertised request params/result 以及 event data 均为 closed schema。新的独立 request/event 必须放在新 capability 下；同一 capability 内只能新增明确 optional 的 response 字段，不能改变已有字段或 enum 语义。

## 6. Core DTO

```ts
type Lifecycle = "active" | "stopping" | "stopped" | "host_lost" | "runtime_error";
type Execution = "idle" | "running" | "failed" | "unavailable";
type LastRun = "never" | "succeeded" | "failed" | "aborted" | "interrupted";
type Delivery = "auto" | "prompt" | "steer" | "followUp";
type DialogMethod = "select" | "confirm" | "input" | "editor";
type ProjectTrustDecision = "trust_once" | "trust_and_remember" | "deny_once" | "deny_and_remember";
type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
type JsonScalar = string | number | boolean | null;
type JsonValue = JsonScalar | JsonValue[] | { [key: string]: JsonValue };
type JsonObject = { [key: string]: JsonValue };

type EventCursor = {
  hostEpoch: string;
  instanceId: string;
  runtimeGeneration: number;
  sequence: number;
};

type DialogRequestDto =
  | { interactionId: string; method: "select"; title: string; options: string[]; issuedAt: string; expiresAt: string }
  | { interactionId: string; method: "confirm"; title: string; message: string; issuedAt: string; expiresAt: string }
  | { interactionId: string; method: "input"; title: string; placeholder?: string; issuedAt: string; expiresAt: string }
  | { interactionId: string; method: "editor"; title: string; prefill?: string; issuedAt: string; expiresAt: string };

interface HostDto {
  pid: number;
  dockVersion: string;
  piSdkVersion: string;
  hostEpoch: string;
  startedAt: string;
}

interface SessionMetricsDto {
  messages: { user: number; assistant: number; toolCalls: number; toolResults: number; total: number };
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
  cost: number;
  context?: { tokens: number | null; contextWindow: number; percent: number | null };
}

Metrics count/token 字段必须是非负 safe integer，`cost` 必须是非负 finite number；`contextWindow>=1`，`percent` 仅允许 `null` 或 `0..100`。Footer cache hit 固定按 `cacheRead/(input+cacheRead+cacheWrite)` 计算。

interface ExecutorDto {
  kind: string;
  version?: string;
  piSessionId?: string;
  sessionFile?: string;
  model?: { provider: string; id: string; name?: string };
  thinkingLevel?: ThinkingLevel;
}

interface PendingDto { steering: number; followUp: number; total: number; }
interface PendingMessageDto {
  queueItemId: string;
  operationId: string;
  delivery: "steer" | "followUp";
  text: string;       // original client text, not template-expanded runtime text
  acceptedAt: string;
}

interface InstanceSnapshotV2 {
  id: string;
  creationOperationId: string;
  name?: string;
  cwd: string;
  lifecycle: Lifecycle;
  execution: Execution;
  lastRun: LastRun;
  reopenable: boolean;
  runtimeGeneration: number;
  ownerHostEpoch?: string;
  interruption?: { reason: "host_crash" | "host_shutdown" | "replacement_failed"; at: string };
  pending: PendingDto;
  executor: ExecutorDto;
  metrics?: SessionMetricsDto;
  extensionStatus: Record<string, string>;
  activeInteraction?: { id: string; method: DialogMethod; expiresAt: string };
  activeCommandId?: string;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
  eventCursor: EventCursor;
}

interface ModelDto { provider: string; id: string; name: string; reasoning: boolean; contextWindow?: number; }
interface ToolDto { name: string; description: string; active: boolean; source?: SourceDto; parameterSchema?: JsonObject; }
interface SourceDto { kind: "built-in" | "extension" | "skill" | "prompt"; path?: string; package?: string; }
interface CommandDto { name: string; description?: string; source: SourceDto; argumentCompletions: boolean; }
interface SessionDto { sessionId: string; sessionFile: string; name?: string; cwd: string; updatedAt?: string; }
interface ResourceDto { kind: "extension" | "skill" | "prompt" | "context"; name: string; path?: string; source?: SourceDto; }
interface DiagnosticDto { severity: "info" | "warning" | "error"; message: string; source?: string; }

interface TreeNodeDto {
  entryId: string;
  parentId?: string;
  depth: number;
  kind: "message" | "thinking_level_change" | "model_change" | "compaction" | "branch_summary" | "custom" | "custom_message" | "label" | "session_info";
  role?: "user" | "assistant" | "tool" | "system";
  label?: string;
  timestamp?: string;
  summary: string;
  hasChildren: boolean;
}

type InstanceEvent = {
  [K in keyof EventDataMap]: {
    scope: "instance";
    sequence: number;
    instanceId: string;
    runtimeGeneration: number;
    occurredAt: string;
    type: K;
    data: EventDataMap[K];
  }
}[keyof EventDataMap];
```

`JsonObject` 是按第 3 节 bounds 处理后的 JSON object，不允许 binary/function/circular value。

### History/content DTO

```ts
type ContentBlockDto =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "tool_call"; toolCallId: string; toolName: string; args: JsonObject; omittedFields?: string[] }
  | { type: "tool_result"; toolCallId: string; toolName: string; text: string; isError: boolean; omittedFields?: string[] }
  | { type: "omitted"; kind: "image" | "binary"; description: string };

interface HistoryEntryDto {
  entryId: string;
  parentId?: string;
  role: "user" | "assistant" | "tool" | "system";
  timestamp?: string;
  content: ContentBlockDto[];
  stopReason?: string;
  error?: string;
}
```

只 allowlist 上述字段。Image block 变成 `omitted`；tool result details 不直接上 wire；`show_image` 的 text path 保留。Tool args 额外执行 bounded sanitizer：Buffer/TypedArray、image/data URI、key 名含 base64/binary/imageData 的 payload 变成 omission；任意长字符串会截断。`omittedFields` 使用相对 JSON Pointer（例如 `/details/base64`）。

## 7. Closed request/result surface

每个 mutation params 都含 client 生成的 `operationId`。它用于关联、same-host dedup 和事后查询，不代表跨 Host exactly-once。下表是 closed schema 的规范简写：未另标注的 ID/path/name/message/text 字段均为受第 3 节 bounds 的 `string`；`?` 表示 optional；`instance` 表示 `InstanceSnapshotV2`；`host` 表示 `HostDto`；`projectTrustDecision` 表示上文 enum。Bare `cancelled/summarize/replaceInstructions/includeTerminal/follow` 为 boolean，数值字段必须是 safe integer。除表中字段外一律拒绝。

| Request type | Capability | Closed params | Success result |
|---|---|---|---|
| `host.info` | `host.info` | `{}` | `{state:"ready"|"mutation_faulted"|"draining", host, catalog:{schemaVersion,revision,lastReconciledAt}, paths:{socket,state}, diagnostics:DiagnosticDto[]}` |
| `instance.create` | `instance.catalog` | `{operationId,cwd,name?,trustChallengeId?,projectTrustDecision?}` | `{instance:InstanceSnapshotV2}` |
| `instance.list` | `instance.catalog` | `{includeTerminal?:boolean}` | `{instances:InstanceSnapshotV2[]}` |
| `instance.get` | `instance.catalog` | `{instanceId}` | `{instance:InstanceSnapshotV2}` |
| `instance.attach` | `events.follow` | `{instanceId,since?:EventCursor,follow:boolean,controller:"claim"|"observe"}` | `AttachInitialDto`，follow=true 后转 event stream |
| `instance.stop` | `instance.catalog` | `{operationId,instanceId}` | `{receipt:{operationId,alreadyStopped,cleanupErrors?:string[]},instance}` |
| `instance.reopen` | `session.reopen` | `{operationId,instanceId,sessionFile?,trustChallengeId?,projectTrustDecision?}` | `{operationId,previousLifecycle:"host_lost"|"runtime_error",instance}` |
| `command.submit` | `session.core` | `{operationId,instanceId,message,delivery:Delivery}` | `{receipt:CommandReceiptDto,instance}` |
| `command.abort` | `run.abort.v1` | `{operationId,instanceId}` | `{instance}`；取消当前 agent/retry/compaction，实例保持可复用 |
| `queue.dequeue` | `queue.control.v1` | `{operationId,instanceId}` | `{receipt:{operationId,instanceId,restored:PendingMessageDto[],inFlight:PendingMessageDto[]},instance}`；steering-first恢复，绝不隐式abort |
| `command.catalog` | `resources.v1` | `{instanceId,prefix?:string}` | `{commands:CommandDto[]}` |
| `model.list` | `models.v1` | `{instanceId}` | `{models:ModelDto[],availableThinkingLevels:string[],instance}` |
| `model.set` | `models.v1` | `{operationId,instanceId,provider,modelId}` | `{instance,settingsWrite:{persisted:boolean}}` |
| `thinking.set` | `models.v1` | `{operationId,instanceId,level}` | `{actualLevel,availableThinkingLevels,instance,settingsWrite}` |
| `tool.list` | `tools.v1` | `{instanceId}` | `{tools:ToolDto[],instance}` |
| `tool.set_active` | `tools.v1` | `{operationId,instanceId,names:string[]}` | `{tools:ToolDto[],instance}` |
| `settings.get` | `settings.v1` | `{instanceId}` | `{settings:SettingDto[]}` |
| `settings.update` | `settings.v1` | `{operationId,instanceId,update:SettingUpdate}` | `{setting:SettingDto,instance,reloadRequired:boolean,hostRestartRequired:boolean}` |
| `resource.get` | `resources.v1` | `{instanceId}` | `{resources:ResourceDto[],diagnostics:DiagnosticDto[]}` |
| `session.list` | `session.core` | `{instanceId,scope:"cwd"|"all"}` | `{sessions:SessionDto[]}` |
| `session.switch` | `session.commands.v1` | `{operationId,instanceId,sessionFile,trustChallengeId?,projectTrustDecision?}` | `{cancelled:boolean,instance}` |
| `session.new` | `session.commands.v1` | `{operationId,instanceId,parentSession?}` | `{cancelled:boolean,instance}` |
| `session.name` | `session.commands.v1` | `{operationId,instanceId,name}` | `{instance}` |
| `session.compact` | `session.commands.v1` | `{operationId,instanceId,customInstructions?}` | `{result:{summary:string,firstKeptEntryId:string,tokensBefore:number},instance}` |
| `session.reload` | `session.commands.v1` | `{operationId,instanceId}` | `{instance,resources:ResourceDto[],diagnostics:DiagnosticDto[]}` |
| `session.history` | `tui.projection.v1` | `{instanceId,beforeEntryId?,limit:1..200}` | `{entries:HistoryEntryDto[],hasEarlier:boolean,nextBeforeEntryId?:string,instance}` |
| `session.tree` | `session.tree.v1` | `{instanceId,treeRevision?,afterEntryId?,limit:1..200}` | `{treeRevision:string,nodes:TreeNodeDto[],leafId?:string,total:number,truncated:boolean,nextAfterEntryId?:string}` |
| `session.navigate` | `session.tree.v1` | `{operationId,instanceId,targetId,summarize?,customInstructions?,replaceInstructions?,label?}` | `{cancelled,aborted?,editorText?,instance}` |
| `session.fork` | `session.tree.v1` | `{operationId,instanceId,entryId}` | `{cancelled:true,instance}`或`{cancelled:false,selectedText:string,instance}`；固定 fork-before user message |
| `session.clone` | `session.tree.v1` | `{operationId,instanceId,entryId}` | `{cancelled,instance}`；实现为 fork-at |
| `interaction.respond` | `extension_ui.v1` | `{operationId,instanceId,leaseToken,interactionId,response:InteractionResponse}` | `{interactionId,state:"resolved"|"already_resolved"}` |

`session.tree` 把当前 SessionManager tree按稳定 depth-first pre-order展平；`limit` 计算所有返回 node，不是只算 roots。Host 为有序结构计算稳定 `treeRevision`（至少覆盖 entryId、parentId、label timestamp/结构）；第一页 request 同时省略 `treeRevision/afterEntryId`。后续页必须回传上一页的 exact revision 与 `afterEntryId`，下一页从它之后开始。每项携带 `parentId/depth/hasChildren`，客户端可渐进重建层级。`truncated=true` 时必须给 `nextAfterEntryId=本页最后 entryId`。Revision 不匹配、entry 不属于该 revision或 runtime generation变化都返回 `invalid_cursor`；因此即使旧 entry仍存在，tree新增/改标后旧 continuation也不会被误用。

`AttachInitialDto`：

```ts
interface AttachInitialDto {
  instance: InstanceSnapshotV2;
  page: { events: InstanceEvent[]; earliest: EventCursor; latest: EventCursor; truncated: boolean; epochChanged: boolean; generationChanged: boolean };
  recentHistory: HistoryEntryDto[];
  historyTruncated: boolean;
  pendingMessages: PendingMessageDto[]; // authoritative Same-Host ephemeral projection
  controller: { status: "acquired"; leaseToken: string } | { status: "observing" | "unavailable" };
  following: boolean;
}
```

`CommandReceiptDto`：

```ts
interface CommandReceiptDto {
  operationId: string;
  instanceId: string;
  accepted: true;
  delivery: "prompt" | "steer" | "followUp";
  queued: boolean;
  acceptedAt: string;
}
```

Receipt 仍表示 Pi preflight 已接受，不表示 run 完成；实现可继续使用封装在 pinned Pi adapter 内的 `preflightResult`。Catalog accepted state commit 后才发送 receipt。Extension command handled-without-run 另发 `command.handled`。

### Queue消费与恢复合同

- `command.accepted{queued:true}`只表示Pi接受了排队请求；Host随后发布`message.queued`，该文本只存在于Same-Host内存、attach projection和wire，绝不进入durable catalog。
- `queue.changed`投影Pi当前steering/follow-up计数，但不是用户消息进入正式transcript的边界。
- 只有Pi公开user `message_start`到达时，Host才发布`message.submitted`。该event带原queue item的`operationId/queueItemId/delivery`，`text`是Pi实际消费的template/skill-expanded文本；pending tray此时移除对应item。
- `pendingMessages`与`queue.dequeue.restored`固定按Pi消费顺序：全部steering FIFO在前，全部follow-up FIFO在后。重复文本通过不可猜`queueItemId`和runtime-text hash按FIFO关联。
- `queue.dequeue`是正式mutation、受operation ledger与`effect_unknown`规则约束。它调用公开`clearQueue()`并返回原始client文本，不abort当前run；Alt+Up使用该操作。Pi在公开`message_start`前会先从内部queue移除消息并可能等待异步extension hook；该极窄窗口内`clearQueue()`已无法撤回的item进入`inFlight`而绝不复制到editor，tray保留至随后`message_start`。Esc/`/abort`仅在`inFlight=[]`时继续调用`command.abort`，任一步都不自动retry。
- detach/reconnect可从同一Host的`pendingMessages`恢复tray；Host loss/reopen清空queue，catalog不保存也不重放任何queue正文。

### Settings closed update union

```ts
interface SettingValueMap {
  autoCompaction: boolean;
  compactionReserveTokens: number;    // read-only, integer 0..2_147_483_647
  compactionKeepRecentTokens: number; // read-only, integer 0..2_147_483_647
  autoRetry: boolean;
  enableSkillCommands: boolean;
  hideThinking: boolean;
  showCacheMissNotices: boolean;
  showHardwareCursor: boolean;
  clearOnShrink: boolean;
  showTerminalProgress: boolean;
  quietStartup: boolean;
  collapseChangelog: boolean;
  enableInstallTelemetry: boolean;
  steeringMode: "all" | "one-at-a-time";
  followUpMode: "all" | "one-at-a-time";
  transport: "auto" | "sse" | "websocket" | "websocket-cached";
  doubleEscapeAction: "fork" | "tree" | "none";
  treeFilterMode: "default" | "no-tools" | "user-only" | "labeled-only" | "all";
  defaultProjectTrust: "ask" | "always" | "never";
  httpIdleTimeoutMs: number;      // integer 0..2_147_483_647
  editorPaddingX: number;         // integer 0..3
  outputPad: 0 | 1;
  autocompleteMaxVisible: number; // integer 3..20
  warnings: { anthropicExtraUsage?: boolean };
}

type SettingKey = keyof SettingValueMap;
type ReadOnlySettingKey = "compactionReserveTokens" | "compactionKeepRecentTokens";
type WritableSettingKey = Exclude<SettingKey, ReadOnlySettingKey>;
type SettingUpdate = {
  [K in WritableSettingKey]: { key: K; value: SettingValueMap[K] }
}[WritableSettingKey];

type SettingDto = {
  [K in SettingKey]: {
    key: K;
    value: SettingValueMap[K];
    source: "global" | "project" | "effective";
    writable: boolean;
    valueType: "boolean" | "enum" | "integer" | "object";
    allowedValues?: Array<string | number | boolean>;
    min?: number;
    max?: number;
    reloadRequired: boolean;
    hostRestartRequired: boolean;
  }
}[SettingKey];
```

Integer bounds、enum、warning object 的 unknown key以及 read-only key update 全部在 setter 前拒绝。`compactionReserveTokens`、`compactionKeepRecentTokens` 必须以 `writable:false` 投影；其余键为 `writable:true`。Model/thinking 使用独立 request。

### Interaction response union

```ts
type InteractionResponse =
  | { method: "select" | "input" | "editor"; value: string }
  | { method: "confirm"; confirmed: boolean }
  | { method: DialogMethod; cancelled: true };
```

Response method 必须与 pending request method 相同；select value 必须精确属于 options。

## 8. State invariants 与 admission matrix

### 组合不变量

- `active` 必须有 current `ownerHostEpoch`、live runtime、`execution=idle|running|failed`。
- `active + idle` 与 `active + failed` 都是 **quiescent**，前提是无 admission/retry/compaction/queue continuation；failed 只表示上一 run 失败。
- `stopping` 可暂时保留 `execution=idle|running|failed`；不再接受 mutation。
- `stopped|host_lost|runtime_error` 必须 `execution=unavailable`、pending 全零、无 active command/interaction/current owner。
- `reopenable=true`只允许`host_lost|runtime_error`且catalog含bounded absolute session/recovery candidate；它不是文件仍存在的保证。Explicit reopen必须再次验证real path、owner、header cwd与project trust；`stopped`永远false。
- `pending.total === steering + followUp`；任何 pending > 0 都不算 quiescent。
- `runtimeGeneration` 从 1 开始，只在成功 initial create、session replacement、reload 或 explicit reopen 时单调递增；generation 变化后 sequence 从 1 重新开始并清空旧 interaction/status/event ring。
- `lastRun=interrupted` 只表示 Host/replacement loss 时存在 conservative busy fact；不能伪装为 failed/aborted。

Parser、catalog loader 和 registry mutation 共用同一个 invariant validator。

### Admission

| 操作 | 允许状态 |
|---|---|
| list/get/history/tree metadata | 任意已知 record；host_lost history/tree需先 reopen才读取runtime branch |
| fresh prompt | `active + quiescent`；failed 在 admission 后转 running并清 lastError |
| steer/followUp | `active + running` |
| model/thinking/tools/settings/session navigate/replacement | `active + quiescent` |
| compact | active；具体 abort/compact 语义交给 Pi，Dock 阻止并发 config/replacement |
| abort | active；run/retry走`abort()`，compaction走`abortCompaction()`，tree branch summary走`abortBranchSummary()`；均等待对应稳定边界，不伪造无关`run.settled` |
| stop | active；stopping/stopped 同 operation 走幂等结果；host_lost/runtime_error 不当作 live stop |
| reopen | `host_lost|runtime_error + reopenable` |
| interaction response | active、同 generation、当前 lease、pending interaction |

## 9. Durable catalog facts 与 commit boundaries

Managed path固定为`$STATE_DIRECTORY/catalog.json`。State directory必须是真实current-user-owned non-symlink `0700`目录，catalog必须是真实current-user-owned non-symlink regular `0600`文件；catalog上限16 MiB、最多10000 records。Loader按严格closed schema拒绝unknown field、future schema、非canonical UTC timestamp、非法enum/path/invariant。Corrupt evidence不rename、不truncate、不自动重建；startup只移除本次Host绑定且inode仍匹配的socket。Host必须先绑定/chmod/验证private socket，再load/reconcile catalog，完成前不ready。

Catalog 不保存 prompt/tool/queue 内容，但必须保存 crash 后保守判断所需事实：

```ts
interface DurableInstanceRecord {
  // identity/session fields omitted here
  lastKnown?: { lifecycle: "active" | "stopping"; execution: "idle" | "running" | "failed"; activeCommandId?: string; pendingCount: number };
  activeCommandId?: string;      // only current raw/live record; normalized unavailable records clear it
  admissionPending: boolean;
  pendingCount: number;          // count only, no queued text
  replacement?: {
    operationId: string;
    kind: "new" | "switch" | "fork" | "clone" | "reload";
    previousSessionFile?: string;
    requestedSessionFile?: string; // switch only
    requestedEntryId?: string;     // fork/clone only
    startedAt: string;
  };
  recoverySessionFile?: string;
  stopRequestedAt?: string;
  shutdownRequestedAt?: string;
}
```

所有 mutation 经过 Host 单写队列。阶段 1D 以registry-owned transaction coordinator和injected `CatalogCommitPort`固定同一线性化/失败合同；显式`serve --dev`仍使用in-memory projection。阶段5 managed `catalog.v1`已把下表“commit”实现为same-directory temp write、file fsync、atomic rename与directory fsync：

| Boundary | 顺序与失败语义 |
|---|---|
| create | 创建 candidate runtime；计算 generation=1；commit active record；成功后才 publish/response。Commit 失败必须 dispose candidate，catalog 保持原 revision。 |
| prompt/steer/followUp | 先 commit `admissionPending=true + admissionOperationId`，再调用 Pi。Preflight reject 时 commit 恢复先前 quiescent state；accept 时 commit running/pending count 后才 receipt。 |
| run settled | commit lastRun + quiescent execution + clear command/pending 后再发布 settled snapshot/event。失败时保留 conservative busy intent。 |
| queue update | commit pending count；失败时旧 busy/admission fact不得被清掉。 |
| stop | 先 commit `stopRequestedAt` 再 cleanup；commit stopped 后才 success response。Startup 遇 stop intent 归一为 stopped/non-reopenable，不重开 runtime。 |
| replacement | trust/target validation后先commit replacement intent（recovery固定previous durable file），再调用runtime method。Cancel清intent；factory/bind失败时若catalog仍可写则commit runtime_error；成功时计算next generation并在一个commit中写目标durable session facts/active state/clear intent，随后publish。Pi尚未物化candidate JSONL时省略active record的`sessionFile`并暂存previous file为`recoverySessionFile`；首次确认candidate为current-user-owned real file的后续commit再切换durable path。目标/error commit自身失败适用mutation_faulted规则。 |
| reopen | 创建并 bind candidate；预先计算 next generation；一个 commit 写 active/idle/new generation；随后 swap/publish。任一 pre-commit/commit failure dispose candidate并保留原 unavailable record。 |
| graceful Host shutdown（阶段 5） | 先 commit `shutdownRequestedAt`，再 bounded abort/dispose；最终 commit host_lost。Crash 看到 shutdown intent 仍归一 host_lost，不当作 explicit instance stop。阶段 1D 的 in-memory Host shutdown只做 non-catalog runtime drain，绝不伪造 explicit `instance.stop`。 |

任何 catalog write failure：

- 在调用 Pi/cleanup等 side effect 前：不执行 side effect，返回 `catalog_write_failed`；
- 在 side effect 后：现有 conservative intent 必须仍在旧 catalog；Host 进入 `mutation_faulted`，拒绝所有新 mutation，只允许 reads并立即走有界 nonzero drain；response 使用 `effect_unknown`（若连接仍在）；
- 不静默继续一个无法诚实恢复的 writable Host。

第一个 post-effect write fault单调触发一次 fatal drain。故障 Host在 drain窗口内只接受 read-only请求，`host.info.state` 报 `mutation_faulted|draining`；新 mutation返回 `mutation_faulted`。首个 fault前已 admitted 的 mutation在同一个有界 deadline内先收敛到自己的 catalog boundary；已完成 side effect、但排在失败 commit 后的 mutation仍以自己的 operation ID 返回 `effect_unknown`。随后才执行 clear queue/abort/dispose的 exactly-once best effort；deadline后不再无界等待同一批 dispatch，serve进程以非零状态退出。故障路径绝不追加 catalog write。

Managed mode 固定默认 socket/state pair并拒绝 override。Dev custom socket 使用 in-memory/独立 injected store，因此不存在两个 socket 指向 managed catalog；加入负向参数测试。

## 10. Host loss、replacement 与 explicit reopen

### Startup normalization

新 Host 只 reconcile catalog，不构造旧 runtime：

- prior epoch `active/stopping` → `host_lost/unavailable`；
- `admissionPending`、active command、running、pendingCount>0 或 replacement intent → `lastRun=interrupted`；
- old idle record 保留先前 lastRun，但 lifecycle 仍 host_lost；
- stop intent → stopped/non-reopenable；shutdown intent → host_lost；
- stopped/已有 host_lost/runtime_error 保持；
- queue count、active command、interaction/status/event ring 清零；
- replacement intent 的 `previousSessionFile` 成为 `recoverySessionFile`；
- 不调用 `SessionManager.open()`、prompt、tool 或 extension handler。

### Replacement recovery policy

所有 `new/switch/fork/clone/reload` 的自动 recovery candidate 固定为 replacement 前的 `previousSessionFile`。Requested target/entry只用于诊断，不在失败后自动打开。目标可能已产生 partial/orphan session file；它只能以后由 session selector 作为显式用户选择出现。

Pi 0.80.6 的 `createBranchedSession()` 在branch尚无assistant message时会返回未来path但延迟创建JSONL。Dock把runtime `executor.sessionFile`与durable catalog path分开：snapshot可展示candidate identity，但在真实current-user-owned、non-symlink file出现前，active catalog省略`sessionFile`并允许`recoverySessionFile=previous durable file`。因此这段idle窗口发生Host loss时只能显式reopen previous durable context，不会尝试打开不存在的candidate，也不会构造或重放selected prompt。

`AgentSessionRuntime` 若在 teardown 后 factory/bind 失败，Dock dispose任何可见 candidate；若 catalog仍健康则 commit `runtime_error/unavailable` 与 `recoverySessionFile=previousSessionFile`。若写该错误状态或目标状态的 catalog commit 本身失败，则不能宣称 runtime_error 已持久化：旧 replacement intent 保留，Host 进入 mutation_faulted/nonzero drain，下一 epoch据 intent 归一。不得声称旧 session 仍 live。

### Explicit reopen transaction

1. 只接受 unavailable/reopenable；
2. project trust/路径校验；
3. 使用 `SessionManager.open()` + `createAgentSessionRuntime()` 创建并 bind candidate；
4. 预计算 `nextGeneration=current+1`；
5. 原子 commit active/idle/session metadata/next generation/clear recovery error；
6. commit成功后才swap registry、publish `instance.reopened`；同Host `runtime_error`若仍有旧attach stream，关闭该stale stream，client必须重新attach新runtime；
7. 任一步失败dispose candidate、保持原catalog record；
8. 不 submit 任何旧文本，不恢复 queue，不声称旧 tool 结果。

Dock `instanceId` 保持；Pi ID/file 来自打开的 session header。

## 11. Project trust preflight

Host 不再像当前 SDK 默认 path 那样无条件 `projectTrusted=true`。

Create/reopen/switch 的 trust 顺序：

1. 在 runtime construction、extension `session_before_*` hook、replacement intent、teardown 或其他 mutation **之前**，只读解析目标 session header并得到 target cwd；
2. `resolve` + existing-directory `realpath` 得到 canonical cwd，检查 trust-requiring resources；
3. explicit challenge decision（若有）只可用于同一 Host epoch、operation type、operation ID、target session/path、canonical cwd，且有短 TTL；
4. 无 challenge 时依次应用 saved `ProjectTrustStore`、global `defaultProjectTrust=always|never`；ask/unknown 返回 challenge；
5. remembered choice 写 trust store；deny 表示继续但不加载 project resources，不是取消 operation；
6. target/canonical path 变化、challenge 过期、在不需要 challenge 时提交额外 decision都拒绝。

Error details：

```json
{"code":"project_trust_required","message":"Project trust decision required","retryable":false,"details":{"challengeId":"uuid","operationId":"uuid","cwd":"/canonical/path","choices":["trust_once","trust_and_remember","deny_once","deny_and_remember"],"expiresAt":"..."}}
```

Trust challenge 是 operation ID 的**未完成 pre-side-effect 状态**，不是 mutation receipt：

- 同 operation ID 在未带 decision 时重复请求，返回同一个未过期 challenge，不执行 operation；
- 只有匹配 challenge ID/target/canonical cwd 的一次 decision 可以 consume challenge并继续原 operation；
- challenge consume 与开始 mutation在同一 Host串行队列中线性化；
- decision response 丢失后不得再次执行 operation，按第 16 节 mutation ambiguity 查询；
- operation 完成/失败后才写普通 receipt cache；已 consume/过期 challenge 的 duplicate 返回稳定错误，不重新进入 side effect；
- challenge operation binding 使用 Host-epoch 内有界且不驱逐的 tombstone 集合；容量耗尽时拒绝新的 ask challenge，不能通过淘汰旧 binding 让 operation ID 改绑 target/type。Host 重启后 epoch 改变，旧 challenge 本来就无效。

第一次 switch 仍有当前 runtime，但由于 trust gate 在线性化序列最前面，它尚未触发 hook/teardown/catalog mutation；因此用户明确回答 challenge 后重发才安全。当前七扩展无 project-trust handler；未知 handler 不进入 V0.1 兼容承诺。

## 12. Attach、history 与 cursor

`instance.attach` 只订阅一个 instance。Cursor 任一维度不匹配时：

- `hostEpoch` 变：`epochChanged=true`；
- runtime generation 变：`generationChanged=true`；
- Host 从当前 generation event 1 开始 replay，并要求 client 用 recent/history projection 重建，不连接旧 sequence。

`earliest/latest` 都是完整 `EventCursor`。Ring 为空时 sequence 为 0。Replay truncation只在相同四维域内计算。

Attach response 生成期间，Host 先注册 listener并暂存 live events，再从同一 committed projection gate取 snapshot/history/ring，发送 response 后按 `(runtimeGeneration, sequence)` flush暂存事件，沿用 V0 已验证的 response-before-event pattern。Generation rollover 只接受下一 generation 的 sequence 1 `session.replaced`，绝不能把新 generation 的低 sequence当成旧 event丢弃。`recentHistory`提供当前 branch 的持久 baseline；Host 按 stable message/tool ID与 closed content fingerprint，以完整 current branch（包括 recentHistory 页之前的 truncated entries）从 replay中删除已被持久 history覆盖的 message/tool frames，避免旧 replay 在 recent history 之后倒序出现，且不依赖 wall-clock timestamp；response 超过 1 MiB 时优先裁可分页恢复的旧 history，再裁旧 event，并设置对应 truncation flag。

长 history 用 `session.history` 反向分页；返回项保持 branch 顺序，`hasEarlier=true` 时 `nextBeforeEntryId` 必须等于本页第一项。`beforeEntryId` 必须属于当前 branch，否则 `invalid_cursor`。Runtime replacement/reload 成功会增加 generation并发 `session.replaced` 作为新 generation 首批 event，client 清旧 projection并重新读取 history。

Host_lost/runtime_error record 没有 live session history surface；TUI 只显示 catalog metadata并提供 explicit reopen。

## 13. Extension UI broker

### Lease scope

- lease 与一个 `follow=true` attach socket绑定并返回不可猜测 token；`controller="claim"` 与 non-follow attach的组合在 side effect 前拒绝；
- 同 instance 同时一个 lease；第二 claim 可降级 observer或返回 unavailable；
- lease **只**仲裁 extension dialogs/editor-directed fire-and-forget，不阻止其他客户端发普通 command/config；
- detach/socket close/Host drain/runtime generation变化立即 release；
- 不实现抢占、转移、心跳或多 controller merge。

### Dialog serialization

每 instance 最多一个 active dialog，额外 dialog FIFO，队列最多 16。超限的新 dialog立即 fail-closed并记录 extension error。Queued/active dialog总寿命最多 5 分钟；extension 更短 timeout优先。

Host 用单一 interaction mutation queue线性化 respond、detach、timeout、signal、replacement：第一个取得 pending state 的动作获胜。Valid response先完成则 response wins并留下同-generation短期 tombstone；cancel先完成则 late response得到 `interaction_expired`。同 tick 行为由该队列顺序决定并必须 deterministic test。

Fail-closed completion：

- explicit cancel/timeout/signal/detach/replacement：select/input/editor → `undefined`，confirm → `false`；
- no controller：立即同样完成；
- `rm-confirm` 当前 undefined-fallthrough 必须在 versioned source package 修复为只有明确“是/全部是”才放行。

### Fire-and-forget

- `notify` → `extension.notification`；
- `setStatus` → generation-local status map + event；
- string widget → optional bounded lines/event；当前 TUI不承诺持久 widget layout；
- setTitle/setEditorText是可选面，当前 adapter显式 unsupported/no-op而不是伪装成功；若后续实现只能发 controller；
- Component/factory/custom footer/header/editor/raw terminal input/`ctx.ui.custom()` 不上 wire；
- 所有 extension terminal projection过滤 C0/C1，并把 data URI/raw base64替换为 omission；官方 client在发送 dialog response前也拒绝这类 payload。

## 14. Settings semantics

`settings.get` 只返回 allowlisted effective/source metadata。`settings.update` 成功边界：

1. 调用 Pi 公开 setter；
2. `await SettingsManager.flush()`；
3. `drainErrors()` 为空；
4. commit Dock snapshot事实并发 event；
5. response。

Pi 0.80.6 `AgentSession.setModel()` 内部调用 `SettingsManager.setDefaultModelAndProvider()`；`setThinkingLevel()`在 Pi 判断需要时调用 default thinking setter。Dock 不重复写第二套默认值，只在 session setter 后 flush/drain。

不同实例不广播 mutation；既有 runtime 保持内存状态。`/reload`/replacement重新读取。Proxy/dispatcher是 Host-global，相关外部配置显示 restart-required。

## 15. Stable instance event union

每种 `data` 都由下列 closed map 定义；`InstanceEvent` 在第 6 节由该 map 构成 discriminated union：

```ts
type CompactionReason = "manual" | "threshold" | "overflow";
type InteractionCancelReason = "user" | "timeout" | "signal" | "detach" | "replacement" | "host_draining" | "overflow";

interface EventDataMap {
  "instance.created": { cwd: string; name?: string; executor: ExecutorDto };
  "instance.state_changed": {
    reason: string;
    lifecycle: Lifecycle;
    execution: Execution;
    lastRun: LastRun;
    pending: PendingDto;
    activeCommandId?: string;
    lastError?: string;
  };
  "instance.reopened": { previousLifecycle: "host_lost" | "runtime_error"; sessionFile: string; runtimeGeneration: number };
  "instance.stopped": { cleanupErrors: string[] };
  "instance.runtime_error": {
    operationId: string;
    kind: "create" | "new" | "switch" | "fork" | "clone" | "reload" | "reopen";
    error: string;
    recoverySessionFile?: string;
  };
  "instance.error": { operationId?: string; source: "event_projection" | "command_background"; error: string; runtimeEventType?: string };
  "command.accepted": { operationId: string; delivery: "prompt" | "steer" | "followUp"; queued: boolean; acceptedAt: string };
  "command.rejected": { operationId: string; reason: string; error: string };
  "command.handled": { operationId: string; kind: "extension_command" | "no_run" };
  "run.started": { operationId: string };
  "run.retry_started": { attempt: number; maxAttempts: number; delayMs: number; error: string };
  "run.retry_completed": { success: boolean; attempt: number; error?: string };
  "run.settled": { operationId?: string; result: LastRun; stopReason?: string; error?: string };
  "message.queued": PendingMessageDto;
  "message.submitted": { operationId: string; messageId: string; role: "user"; text: string; delivery: "prompt" | "steer" | "followUp"; queueItemId?: string };
  "message.delta": { messageId: string; block: "text" | "thinking"; delta: string };
  "message.completed": {
    messageId: string;
    role: "user" | "assistant" | "tool" | "system";
    content: ContentBlockDto[];
    stopReason?: string;
    error?: string;
  };
  "tool.started": { toolCallId: string; toolName: string; args: JsonObject; omittedFields?: string[] };
  "tool.args_updated": { toolCallId: string; args: JsonObject; omittedFields?: string[] };
  "tool.output_updated": { toolCallId: string; text: string };
  "tool.completed": { toolCallId: string; toolName: string; text: string; isError: boolean; omittedFields?: string[] };
  "queue.changed": PendingDto;
  "queue.cleared": PendingDto & { queueItemIds: string[]; reason: "dequeued" | "abort" | "stop" | "replacement" | "host_draining" };
  "compaction.started": { reason: CompactionReason };
  "compaction.completed": { reason: CompactionReason; aborted: boolean; willRetry: boolean; error?: string };
  "session.replaced": {
    reason: "new" | "resume" | "fork" | "reload";
    previousSessionFile?: string;
    sessionFile?: string;
    runtimeGeneration: number;
    cwd: string;
    piSessionId: string;
  };
  "session.info_changed": { name?: string };
  "session.metrics_changed": { metrics: SessionMetricsDto };
  "model.changed": { provider: string; id: string; thinkingLevel: ThinkingLevel; availableThinkingLevels: ThinkingLevel[] };
  "thinking.changed": { requested: ThinkingLevel; thinkingLevel: ThinkingLevel; availableThinkingLevels: ThinkingLevel[] };
  "resources.reloaded": { resources: ResourceDto[]; diagnostics: DiagnosticDto[] };
  "settings.changed": { key: SettingKey; value: SettingValueMap[SettingKey]; reloadRequired: boolean; hostRestartRequired: boolean };
  "settings.write_failed": { key: SettingKey | "model" | "thinking"; error: string };
  "interaction.requested": DialogRequestDto;
  "interaction.resolved": { interactionId: string; method: DialogMethod };
  "interaction.cancelled": { interactionId: string; method: DialogMethod; reason: InteractionCancelReason };
  "extension.notification": { message: string; level: "info" | "warning" | "error" };
  "extension.status_changed": { key: string; text?: string };
  "extension.widget_changed": { key: string; lines?: string[]; placement?: "aboveEditor" | "belowEditor" };
  "extension.error": { source?: string; event?: string; error: string };
}
```

Numeric counters必须是 non-negative safe integer；timestamp使用 ISO-8601 UTC string；所有 string/array继续受第 3 节 bounds。Event ring 是 bounded memory。Catalog 不保存这些 payload；Pi session history负责 durable conversation。

## 16. Mutation ambiguity 与 retry policy

### 可自动 retry（新连接、新 requestId）

仅 read-only：hello、host.info、instance.list/get/attach、command.catalog、model.list、tool.list、settings.get、resource.get、session.list/history/tree。

### 不可自动 retry

所有 mutation：instance create/stop/reopen、command submit/abort、queue dequeue、model/thinking/tool/settings mutation、session switch/new/name/compact/reload/navigate/fork/clone、trust remember decision。Transport close 后 client 显示 `effect_unknown`，用户先查询再决定。

| Mutation | 收敛查询 |
|---|---|
| create | `instance.list` 按 `creationOperationId` 查找；找不到也不能假设 extension startup无副作用。 |
| prompt/steer/follow | instance snapshot + activeCommandId、history/events；新 epoch同 operation ID只返回 interrupted/unknown，不重新 submit。 |
| abort | instance execution/lastRun + run/compaction events；不自动重复 abort。 |
| queue dequeue | instance pending + attach `pendingMessages` + `queue.changed/queue.cleared`；未知效果时不猜测或自动重复clear。 |
| model/thinking/tools/settings | 对应 get/list + instance snapshot。 |
| session mutation | instance Pi IDs/runtime generation + history/session list。 |
| compact | instance execution/compaction events + history。 |
| stop/reopen | instance.get lifecycle/generation。 |
| trust remember | 下一次 trust resolution/store结果；不自动重写。 |

`interaction.respond` 是唯一受限 mutation retry：在**同 hostEpoch、instanceId、runtimeGeneration、leaseToken、interactionId、相同 response**内，可根据短期 tombstone返回 `already_resolved` 而不再次 resolve；跨 epoch/generation禁止 retry。

Host 对same-host重复operation ID保留bounded receipt cache；同mutation type/params的并发或已完成duplicate共享原Promise/result/error且不重复side effect，type/params冲突的复用返回`operation_conflict`。只淘汰最旧settled receipt，不淘汰live operation。`instance.catalog`表示当前Host registry surface；managed `catalog.v1`持久化identity、live intent和保守状态，但不保存所有mutation receipt，也不承诺cross-Host exactly-once。已持久化creation operation拒绝重新create并要求查询`instance.list`；其他response loss仍按unknown effect处理。

## 17. Error codes 与 code-specific details

最低集合：

- hello：`invalid_hello`、`unsupported_protocol`、`capability_missing`、`host_starting`、`host_draining`；
- framing：`invalid_envelope`、`request_too_large`、`response_too_large`；
- service/client：`service_unavailable`、`service_start_failed`、`service_start_timeout`、`protocol_incompatible`；
- catalog：`catalog_corrupt`、`catalog_write_failed`、`effect_unknown`、`mutation_faulted`；
- instance：`not_found`、`instance_busy`、`instance_not_active`、`instance_host_lost`、`instance_runtime_error`、`instance_not_reopenable`、`operation_conflict`；
- session/config：`session_not_found`、`session_replacement_failed`、`model_not_found`、`invalid_thinking`、`unknown_tool`、`settings_invalid`、`settings_write_failed`、`project_trust_required`、`queue_capacity`；
- interaction：`interaction_lease_unavailable`、`interaction_not_found`、`interaction_expired`、`interaction_wrong_lease`、`interaction_invalid_response`。

Error envelope固定 `{code,message,retryable,details?}`。`details` 仅按 code：

- protocol/capability：version/capability string arrays；
- project trust：第 11 节 challenge DTO；
- settings/catalog：sanitized scope/path（不得含文件正文）；
- effect_unknown：`{operationId,queryHint}`；
- busy：`{lifecycle,execution}`。

其他 code 不允许 details。错误不得包含 auth token、完整 environment、base64 或未裁剪 stack。

## 18. systemd service 与 Host protocol 边界

`alu-dock service start|restart|install --now`都必须等待V2 hello、`catalog.v1 + service.managed.v1 + session.reopen + session.tree.v1` capability集合，并验证hello PID等于unit `MainPID`；对已可probe的restart还必须观察到不同`hostEpoch`。Timeout只报告失败和unit journal诊断，不自动删除catalog或反复stop/start unit。

Host drain 总预算 12 秒，给 unit `TimeoutStopSec=15` 留 3 秒 kill margin：停止 admission/cancel dialogs → commit shutdown intents → bounded abort/dispose → commit host_lost → inode-safe socket cleanup。超时非零退出；下一 epoch按 shutdown/busy intent保守 normalization。

测试必须覆盖 readiness永不到达、restart期间旧 epoch socket仍响应、hung create/preflight、SIGTERM budget与最终 SIGKILL。

Host `start/stop/restart/status/logs/install/uninstall`是CLI对`systemctl --user`的显式管理，不走Host RPC。只有带生成marker的user unit可被覆写/删除；uninstall不删catalog/session。普通`open/new/attach`只bounded等待socket，绝不调用systemctl或fork detached进程。`/stop`/`instance.stop`永远只表示一个instance。

## 19. 1.0 前绿地开发规则

Alu Dock 到 1.0 落地前默认是纯绿地开发。除非用户特意说明：

1. 不保留原型协议、Host、catalog、socket、CLI flag 或 DTO 的兼容路径；
2. 不建设迁移、upgrade、双读、双写、双栈或历史数据修复；
3. 合同变更直接同步 Host、client、CLI/TUI、tests 与文档；
4. unsupported version/shape 只是普通非法输入，统一 fail closed，不写版本专用提示或处理分支；
5. 本文的 protocol/capability/catalog schema 版本用于当前合同演进，不隐含任何已发布旧版本支持义务。

达到 1.0 或用户明确冻结兼容边界后，再单独设计版本支持与迁移政策。