# Agent Worker 与 Runtime

## 这部分负责什么

Agent Worker 负责运行真正的 Agent。当前实现是 Pi，未来可以增加其他 Agent adapter。

Host 管理 Worker，但不在 Host 中模拟 Agent runtime。客户端通过 Protocol V2 与 Dock 通话，Host 完成控制判断后把 Agent 会话流量路由给对应 Worker。

```text
Protocol V2 client
        │
        ▼
Dock Host Service
 control + routing
        │
 private Worker transport
        │
        ▼
Agent Worker
        │
   Agent adapter
        │
 Pi / future Agent
```

## Host 与 Worker 的边界

Host 负责：

- instance、catalog 与 runtime kind；
- Worker 创建、停止、replacement 与 generation；
- admission、Queue、operation 与 Extension UI 操作权；
- 把请求和事件路由到正确的客户端与 Worker。

Worker 负责：

- Agent runtime 与原生 session；
- tools、extensions、components、callbacks 与 Promise；
- Agent 的 conversation、model、settings、tree、compaction 等实际机制；
- 把 Agent 行为转换成 Dock 的 command、event 和 result。

Host 可以因为 instance、generation、operation、Extension UI 操作权或 lifecycle 不正确而拒绝请求，但不重新解释 Agent 内容，也不为 Agent 的每个方法建立本地代理。

## Worker 环境

Host 与 Worker 不共享整套环境变量。Managed Host 只保留 service 自身的固定运行环境；创建 Worker 时，Dock 从当前用户的交互式登录 shell 初始化用户环境，随后进入该 Worker 的 workspace，让 RVM 等目录 hook 完成项目选择，再捕获导出的环境启动 Worker。Host 的 `NODE_ENV`、systemd runtime/state、npm lifecycle 和 Dock 管理环境不得因此进入项目开发环境。

每个 Worker 独立捕获一次，Host 不修改自己的 `process.env`，也不在 local install 时固化某个项目的语言版本或 PATH。Worker 只在捕获结果之上显式加入 identity、IPC 和 bootstrap 所需的 Dock 私有变量。普通 Bash 命令自行 `cd` 到其他目录时不重新捕获；新的 Worker（包括 reopen）重新按其初始 workspace 捕获。

## Worker 通信

Protocol V2 定义 Dock 的业务语义。Host 与 Worker 之间的私有通信只补充进程所需的信息，例如 Worker identity、generation、调用关联、接收确认、分帧和背压。

Pi adapter 直接从 `SessionManager.getTree()` 产生 Protocol V2 的 compact `{nodes, leafId?}` 完整 snapshot，并复用 `protocol.ts` 的唯一 parser/type；raw Session entry、完整 message/tool content 不跨 Worker 边界。navigate/fork/clone 的 target membership 与 Pi 原生目标规则也在 adapter 内校验，Host 不为此读取或维护 Tree index。既有 generic Worker envelope chunking 原样承载这个结果；公开 `response_transfer` 是之后 Host→client 的透明 transport framing，不是 Worker tree chunking。

同一项能力不能分别维护一套 RuntimeSession 方法、Worker capability、Host projection 和客户端 DTO。Worker 返回 Dock 已定义的结果和事件，Host 验证归属后转发。

事件分两类，边界不同。conversation frame（message/tool 事件）已经是 Protocol V2 词汇，Host 逐字转发，只补队列关联；生命周期信号（agent_start、queue_update、compaction 等）是 Worker 向 Host 权威提供的输入，Host 从中导出携带自身事实（operation 归属、合并队列计数、catalog 提交顺序）的 Dock event——这是权威在工作，不是重复投影，不要把它改成 Worker 直发。每个信号在 ManagedInstance 中只有一张转换表，durable 与非 durable 路径共用；不得按持久化模式分叉第二份。

客户端不直接连接 Worker。这样 Worker replacement、旧 generation 隔离、controller 与 reconnect 仍由 Host 统一处理。

## Pi adapter

Pi runtime、Pi session、extension runner、component 和 Pi SDK object 全部留在 Worker。Pi adapter 只在 Worker 内使用 Pi API，并把 Pi 的行为转换成 Dock 协议。

消息提交的实际 delivery 也由 adapter 在 Pi 真正接收输入时确定。调用者的 `auto / prompt / steer / followUp` 原样到达 Worker；Pi 完成 input hook 并再次检查运行状态后，Worker 的私有 preflight result 报告这次实际采用的 `prompt / steer / followUp`。Host 只按这个结果提交 receipt 和 Queue 状态，不根据自己稍早看到的 `isStreaming` 再猜一次。`operationId` 贯穿直接执行和排队执行；只有确实进入 Queue 的消息才创建 `queueItemId`，也只有实际消费 Queue item 时才产生 queue-consumed lifecycle。Queue provenance 与最终 delivery 分开保存：compaction 期间由 Host 保管的 Queue item 可能在 Pi 恢复空闲后以 fresh prompt 启动，但它仍消费原来的真实 Queue identity；普通 direct prompt 则不会产生 queue-consumed。

Conversation projector 使用同一个实际 delivery 生成 `message.submitted`。Canonical conversation frame 不以 Host 的辅助 Queue identity 为发布前提：即使 Queue 关联异常，已经被 Worker 接受的用户消息也必须先出现在 conversation，不能被内部错误替代。

Conversation 的持久语义也在 adapter 内完成。Pi adapter 把当前 branch entry 投影成 canonical persisted record，显式保留 message、tool result、custom/custom message、bash execution、compaction/branch summary、model/thinking/session/label record 及其 visibility/metadata；Host 不读取 Pi role 或 Pi session 私有 shape。大型内容的 record 只承载有界 preview，完整内容由 conversation history/content 的 revision、content ref 和 chunk 提供。Adapter 与 Host 的 history 分页都以 canonical `toolCallId` 形成完整语义单元，不能把 Assistant tool call 与已有的对应 results 拆页；这不增加另一套 owner identity。Worker 私有协议还限制整个 conversation history page 的传输字节数；adapter 应先去除可由 content ref 读取的 preview，而不是拆开语义单元。

实时事件与持久 record 不需要共享 identity。在线客户端在 `message_update`/tool event 上原位更新组件，完成后直接保留；重建时才从持久 record 重新生成。Adapter 在一个 turn、run、compaction 或独立持久写入形成安全边界后发出私有 `conversation_checkpoint`。Checkpoint 携带该边界的精确权威 branch history snapshot，表示它之前的 conversation frame 都已由这份 snapshot 表达；Host 原子安装 snapshot 并释放 active buffer，不能在稍后读取一个可能已经前进的 history 来猜测边界。Checkpoint 不等待任何客户端确认。

Pi 是当前成熟基底。真实工作需要且 Pi 已经具备的能力，应完整接入 Dock；不能因为某个客户端尚未实现、跨进程不方便或未来 Agent 可能不同而降低能力。

Pi 的 abort 会等待 Agent 回到 idle；如果客户端没有先恢复 Queue，已排队输入可以在当前输出终止后合法启动下一轮，因此 abort 的完成时间不是 Worker 存活探针。Host 不因 abort 尚未返回而切断 Worker。需要像 Pi TUI 一样把排队文本恢复到输入框的客户端，应先调用既有 Queue dequeue，再在确认没有正在进入 Pi 消费的消息后 abort；Host 不替客户端合并这两个不同意图。Compaction 只是运行中的暂停边界：completed 后 Pi 自己的 retry、extension/guard continuation 仍按原生顺序继续，Host-deferred Queue 在第一个合法时机自动交付，不能抢断 continuation，也不依赖任何客户端在线。

### Agent-facing Host capability pattern

Agent 需要访问 Host-owned 事实时，复用 observation 已建立的 reverse-capability 形状，而不是增加 Worker 直连、把 Host object proxy 进 runtime，或建立通用任意 RPC：

1. `src/core/` 定义一项 capability-specific HostPort 与 Dock 已有 DTO；
2. Registry 在创建/reopen Worker 时注入 HostPort；
3. `AgentWorkerConnection` 只从已认证连接上下文取得 `sourceInstanceId`，并继续使用 host epoch、runtime generation、worker incarnation 和 ordered private envelope fencing；Worker request 不能自行声明 caller identity；
4. Worker bootstrap 只在 Host 授予对应 `dock.*` capability 时建立一个小型 bridge；
5. Agent adapter 用 inline extension/tool 或其他 runtime-native API 暴露能力，需要长期使用说明时随包装载 bundled Skill。

每项能力保留自己的 closed request/result、bounds 和开关规则，不把这个 pattern 扩张成第二套 Protocol V2。公开业务 DTO 仍只在 Protocol V2 定义一次；private envelope 只验证 source binding、路径等 Host-private fact 和跨进程边界。

`dock.attachments` 是这个 pattern 的第二个实现，而且始终随 managed Worker 提供。`command.submit` 的 full attachment metadata 通过 private invoke context 与公开 file IDs 做逐项一致性检查；Pi adapter 把一个明确的 untrusted metadata block 放进原生 prompt，同时在 live/history projection 中恢复干净文本和 `AttachmentDto[]`。该内部 block 由 Worker 使用 agent state 中持久、`0600` 的随机 key 做 HMAC 认证；普通 prompt 即使复制相同文本形状也不能伪造 attachment provenance，认证失败的文本不会被静默剥离。Host path 不进入 invoke context、Queue 或 conversation。

Pi inline extension 提供 `dock_attachment_list` 和 `dock_attachment_resolve`。list 只返回 path-free metadata；resolve 通过当前 authenticated Worker 的 reverse call 让 Host 检查文件后，把一个 absolute path 只交给 Agent tool result。外部 conversation projector 对 resolve tool text 做固定 redaction，structured details 也不含 path。Bundled `dock-attachments` Skill 指导 Agent 在修改、转换或解压前，把原文件复制到 workspace 或临时目录并保留永久原件；文件名、media type 和内容一律是不可信数据。普通 resolve 不把任意文件塞进 Pi 的 image loader，也不假装提供 UID 之外的沙箱。

当 `command.submit` 的 authenticated attachment context 含 `image/*` metadata 时，Pi adapter 在真正 delivery 前经同一个 attachment reverse capability resolve 每个图片 fileId，把 private Host path 只转换为本轮 Pi 原生 image input，同时继续把完整 attachment metadata 放进已认证的 prompt context。显式 image 与 attachment-derived image 共用 Pi 已有的数量、单图和 aggregate bytes 检查；Dock 不维护 model/provider 视觉能力表。Pi user message 中图片 bytes 的 SHA-256 与已认证 `AttachmentDto.sha256 + mediaType` 相同时，live/history projector 给 image block 加上对应 `fileId`；它不删除 image block 或 attachment，也不把 Host path 放进 Worker result、Queue 或 conversation。

Dock 通过 Pi resource `extensionsOverride` 明确持有 canonical inline `show_image`，只移除其他 extension 注册的同名 tool，不依赖修改用户的 `~/.pi`。tool 只把 `{path}` 登记到 Worker-local generation/session registry，Pi session 不持久化图片 bytes；live 与 history projector 从 structured details 产出同一个 path-free `PublishedFileDto`。`file.read` 经 Host 原样路由到当前 generation 的 Worker。原生 Pi ImageContent 同样只在 live event 发布 opaque conversation content ref，bytes 仍由 `conversation.content` 显式读取；这里没有 provider context hook。

Pi Worker 内建 `/dock-tools on|off|status`。开关按来源 instance 持久化，默认关闭；新建、adopt 和从别的来源创建的 instance 都不会继承。`dock.tools.configure` reverse capability 始终存在，但 Host 只在开关为 on 时授予 `dock.tools`；off 时 bundled Skill 不进入 Pi resource prompt，下面七个 tool 也不在 active set。显式切换会执行一次 Pi resource reload，让 tool system prompt 与 Skill 同步；普通 turn 不逐次改 prompt，session reload/rebind 继续从 Worker-level capability state 恢复。

开关开启后恰好提供：`dock_list({scope?: "live" | "all"})`、target 必填的 `dock_inspect`、`dock_watch`、`dock_cancel_watch`、`dock_deliver_file({path})`、`dock_create({cwd,name?})` 和 `dock_send({target,message})`。list 只读短状态，不拉取 conversation；inspect 才按需读取一个 bounded page。Agent-facing client 把 canonical message page 渲染成短小的 `target_user / target_assistant / target_other` 引用流，每行 sibling 内容都处于明确的 untrusted quote 边界；结构化 DTO 只留在 tool details，不把 JSON、TUI reconnect event、thinking、tool call/result 或 Host metadata dump 放进模型上下文。默认读取最近一条，Agent 只有在主人需要更早内容时才使用 continuation cursor。

`dock_deliver_file` 只接受 absolute path。Host 从 authenticated Worker connection 取得 source instance，把 readable regular source 的 path 与 identity metadata 暂存在当前 `ManagedInstance`；它不在 registration 时读全文、hash、复制或持久化。最多 100 MiB（含边界），跨 Pi session replacement 保留，stop/Host restart 后消失；已有登记不因 `/dock-tools off` 删除。公开 list/download 只含 path-free `DeliverableDto`，bytes 由 Host 专用 stream 直接送给客户端并用 terminal SHA-256 核对，始终不经过 Worker。`show_image` 继续使用独立的 Worker session-scoped inline image 语义。

`dock_create` 只接受 absolute cwd 和可选名称，沿 Host 的 canonical `instance.create` application service 创建，且新 instance 的 Dock tools 仍为 off。`dock_send` 先把 human-readable source display name 与固定来源说明包在正文外，再沿同一个 `command.submit` application service 使用 `delivery: auto`；因此目标的运行中/空闲判定、Queue、receipt、持久 conversation 与普通 user message 完全一致。包装不暴露 UUID、不改写内部 message body，也不会伪装成主人亲自输入。Dock tools 不提供 stop、interaction answer 或任意 Agent 私有控制。

watch tool 只登记 Host subscription 并立即返回。Host completion 通过私有 `observation_delivery` control 到达当前 Worker；completion 只含 target/reason/time，不携带 sibling conversation。adapter 写入可见的 `dock-tools-watch` custom message，并用 Pi public `sendMessage(..., { triggerTurn: true, deliverAs: "followUp" })` 唤醒 Agent；Agent 醒来后按主人原始意图决定是否 inspect。Host 不走 `command.submit` 冒充主人。reload 的短暂无 binding 窗口由 Worker bridge 有界暂存 completion；cancel/off 会先在本地 fence pending delivery，同一 watch ID 至多唤醒一次。Bundled `dock-tools` Skill 只在开关开启时出现，说明按需读取、等待、创建和消息来源边界。

## Extension UI

Extension component 和 Promise 留在 Worker。Worker 负责 component render、input、invalidate 与完成回调；Host 负责 generation、当前操作者和定向路由；TUI 或 WebUI 负责各自支持的显示与输入。读取和实时跟随不取得操作权；新的操作连接会立即替换旧连接，但不会取消 Worker 中等待的 interaction。

某个客户端没有实现一种 Extension UI，只影响该客户端，不影响 extension runtime、Agent 或其他客户端，也不能产生假的用户回答。

Extension command 仍通过完整 Agent input 语义执行，不另建第二条命令通道。Worker 在执行前确认当前输入确实命中已注册的 Extension command，并只在该 handler 尚未结束时，把同一次提交已有的 `operationId` 附到 `extension.notification`。它只表达来源关联：通知仍不是 conversation record。handler 返回后遗留的 timer、后台任务以及其他被动 Extension 通知不携带该 ID；Host 不按文本、时间或命令名称猜测来源。

## 新增 Agent 或能力

新增使用现有 Dock 能力的 Agent时，只增加 Worker adapter 和 runtime kind 注册，不修改 Pi adapter和不相关客户端。

Agent 出现新的真实能力时，在 Protocol V2 定义一次，由提供该能力的 Worker adapter 产生，再由需要它的客户端实现。Host 只有在这项能力确实增加新的控制或生命周期规则时才需要变化。

## Pi SDK 升级

频繁的 Pi 版本升级使用独立的[兼容性准入门](../pi-sdk-upgrades.md)，不混入普通测试套件。入口是 `npm run test:sdk-upgrade`，场景实现在 `test/pi-sdk-compat/`；它经过真实 Dock/Worker/Pi public SDK 边界，但只连接本机确定性 transport，不访问外部模型。

## 代码范围

- `src/pi/`：当前 Pi Worker、Pi adapter、Dock capability extensions 与 Worker 进程实现。
- `skills/dock-attachments/`、`skills/dock-tools/`：随包发布的 Agent 使用说明。
- `src/control/`：Host control、Worker supervision 与 session routing。
- `src/core/`：Dock 自己的协议数据与跨实现概念，不依赖 Pi runtime。
- `src/tui/`：本机终端客户端（通常经 SSH 使用），不持有 Agent runtime。

具体实现应服从以上边界。任何普通 Agent 能力如果需要在多个层次重复定义和投影，应先修正边界，而不是继续增加转发代码。
