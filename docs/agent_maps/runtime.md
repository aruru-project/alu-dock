# Agent Worker 与 Runtime

## 这部分负责什么

Agent Worker 负责运行真正的 Agent。当前实现是 Pi，未来可以增加其他 Agent adapter。

Agent runtime 在 Worker 中运行。客户端通过 Protocol V2 与 Dock 通话，Host 完成控制判断后把 Agent 会话流量路由给对应 Worker。

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

Host 与 Worker 不共享整套环境变量。Linux managed Host 只保留 service 自身的固定运行环境；创建 Worker 时，Dock 从当前用户的交互式登录 shell 初始化用户环境，随后进入该 Worker 的 workspace，让 RVM 等目录 hook 完成项目选择，再捕获导出的环境启动 Worker。Host 的 `NODE_ENV`、systemd runtime/state、npm lifecycle 和 Dock 管理环境不得因此进入项目开发环境。

Windows 前台 Host 没有 POSIX login shell；Worker 继承启动 PowerShell 已经具备的 Windows/GPU开发环境，并把 workspace 作为本次 Worker 的 cwd。Pi 按自身 Windows 规则使用显式 `shellPath`、Git for Windows 或 PATH 中的 Bash。Dock 不复制一份 shell 查找算法。

每个 Worker 独立取得一次环境，Host 不修改自己的 `process.env`，也不在 local install 时固化某个项目的语言版本或 PATH。Worker 只在结果之上显式加入 identity、IPC 和 bootstrap 所需的 Dock 私有变量。普通 Bash 命令自行 `cd` 到其他目录时不重新捕获；新的 Worker（包括 reopen）重新按其初始 workspace取得环境。

Pi adapter 通过 SDK 嵌入 runtime 时，Host 必须在 fork 前把当前 Pi package、Node executable、标准 Pi 标记和只含 `pi`、`aludock` 两个 launcher 的私有 bin 注入 Worker 环境；私有 bin 不得把 Dock 的整套 `node_modules/.bin` 混入 workspace。`pi` 固定启动随 Alu Dock 安装的同一 Pi package，`aludock` 固定回到随包 Dock CLI。Worker 在加载 extension 前从同一 package authority 恢复 CLI process identity。Extension、workspace shell 和它们创建的 Pi 子进程因此与父 Worker 使用同一 package，不得从用户 PATH 猜测或回退到另一份全局 Pi。

## Pi 原生配置与身份

Pi 继续唯一拥有 `~/.pi/agent`（或 `PI_CODING_AGENT_DIR` 指定目录）中的 settings、`models.json`、`auth.json`、packages/extensions 和 `sessions/`。Dock 不创建 Profile、凭据副本、配置投影、导入流程或另一处 Session root。Managed Host 没有调用终端的 shell environment 时，会在启动时从用户 login shell 解析一次 Pi 原生 agent directory，但不保存 Dock 副本；解析结果同时供 inventory 和 Worker 使用。Host 解析出的 Pi `agentDir` 会作为 Pi 自己的环境契约传入 Worker，因此默认 Session 路径、nested Pi 与 `aludock pi:install` 仍指向同一份 Pi 环境；project `.pi`、`.agents`、Project Trust 与 Pi precedence 继续由每个 Worker 原生加载。

本机 Hub 通过 bundled Pi 的 public model/auth API 读取当前 Providers、models 与非秘密 access 状态，并让 Pi 自己执行 API-key login、OAuth login/logout 和 token persistence/refresh。`aludock pi:install <source>` 直接调用 bundled Pi package manager 并写入 Pi 的 global package settings；source 只承诺 Pi Package conventions。`aludock update model` 在 Windows/Linux 都直接调用 bundled Pi 的公开 `ModelRuntime.refresh({ allowNetwork: true, force: true })`，由 Pi 更新自己的持久模型目录；Dock 不复制下载、解析或合并逻辑。现有 Worker 不被 Host 热改配置，用户通过 `/reload` 采用 package/model 环境变化。

每个 Pi Worker 的 resource prompt 会追加稳定的 Alu Dock 身份说明：它知道自身是由 Dock 管理、终端断开后 Work 仍可继续，并知道 Pi 原生配置与 Session 仍归 Pi。`ALU_DOCK_PI_WORKER=1` 只是私有进程 bootstrap marker，不是 Agent 的产品身份接口。

`instance.create` 可携带 bounded JSON `workerConfig`。这个对象在 generic Protocol/Host/catalog 中保持 opaque，随 durable reopen 原样交给选中的 Worker adapter；Host 不枚举字段、不把 Pi option 提升为 Dock 语义。Pi adapter 把其中 JSON-safe create fields 交给 Pi 的 session constructor，Worker-owned services、SessionManager、identity 与 transport 不能由该对象替换。不同 Agent adapter 可以按自己的原生 contract 解释同一容器。

### 显式 system 来源

Pi provider 生成 `workerConfig.systemSelection`：原生 `project-system`/`global-system` 保留 custom 文本语义；`dock-template` 是 fork SDK 的 `DefaultSystemPromptBody` 五字段 JSON（`intro/toolNotes/guidelines/documentationHeading/documentationInstructions`），不是最终组装 prompt，也没有占位符语言。项目来源同时保存原始 cwd，Dock 模板保存发现时的原始 Home（限定其 `.aludock/systems/*.json`），避免 session replacement 或 Worker 登录 shell 改变 HOME 后重新发现或拒绝原来源。模板选择必须携带来源 Home；没有 systemSelection 的旧 Work 继续使用原生行为。

Adapter 在创建 resource loader 时注入 `systemPromptResolver`，每次加载读取固定选中文件并同时返回 custom/default 内容及实际 `source.path`；显式选择覆盖项目 SYSTEM，但 APPEND、context、skills、动态 tool prompt 继续由 Pi 原生组装。读取或校验失败明确失败，不把路径当正文、不回退。Host 不解释这个 workerConfig。配置随 durable catalog/reopen 原样保留，工具重建不查询目录默认；没有配置的旧 Work 保持原生行为。

既有 `resource.get`/`resource.content` 自动使用 loader 的实际 source，所以 Work 读到的是选中的 JSON 或原生 SYSTEM 文件，而不是被覆盖的项目 SYSTEM，也不是最终组装快照。

## Worker 事故记录

Host 对 Worker stderr 做有界尾部捕获，同时继续写入自己的 stderr，因此 Linux journal 与 Windows Host 窗口仍能显示即时输出。正常停止不产生事故记录；Worker 非预期退出、IPC 丢失或 transport deadline 导致所有权回收时，运行该 Worker 的 Host 在私有状态目录写入独立、不可变的 incident。记录包含 Machine、Work、runtime generation、退出原因、平台与保存的 stderr 尾部。

Incident 不属于当前运行状态，reopen 不删除它；清理由独立的有界保留策略决定。`aludock diagnostics` 读取本机最近记录，`--verbose` 才显示保存的错误输出。SubHost 事故首先保存在 SubHost；当前没有把原始 stderr 持续复制到 Main，也没有跨机 diagnostics 协议。

## Worker 通信

Protocol V2 定义 Dock 的业务语义。Host 与 Worker 之间的私有通信只补充进程所需的信息，例如 Worker identity、generation、调用关联、接收确认、分帧和背压。

Pi adapter 直接从 `SessionManager.getTree()` 产生 Protocol V2 的 compact `{nodes, leafId?}` 完整 snapshot，并复用 `protocol.ts` 的唯一 parser/type；raw Session entry、完整 message/tool content 不跨 Worker 边界。navigate/fork/clone 的 target membership 与 Pi 原生目标规则也在 adapter 内校验，Host 不为此读取或维护 Tree index。Clone 可选任意仍有效的历史节点，按 position=at 从该处创建新 Pi Session，原保存 Session 不变、Dock Work identity 不变；不能额外限制为当前 leaf。既有 generic Worker envelope chunking 原样承载这个结果；公开 `response_transfer` 是之后 Host→client 的透明 transport framing，不是 Worker tree chunking。

同一项能力的结果体和事件在 Dock 协议中定义一次，Worker、Host 和客户端复用该定义。Worker 返回 Dock 已定义的结果和事件，Host 验证归属后转发。

事件按所含事实分为两类：

- conversation frame（message/tool 事件）已采用 Protocol V2 形状，Host 逐字转发，只补队列关联。
- 生命周期 Dock event 包含 Host 管理的 operation 归属、合并队列计数和 catalog 提交顺序，因此由 Host 生成；Worker 提供 agent_start、queue_update、compaction 等生命周期信号。每个信号在 ManagedInstance 中使用唯一转换表，durable 与非 durable 路径共用。

客户端不直接连接 Worker。这样 Worker replacement、旧 generation 隔离、controller 与 reconnect 仍由 Host 统一处理。

## Pi adapter

Pi runtime、Pi session、extension runner、component 和 Pi SDK object 全部留在 Worker。Pi adapter 只在 Worker 内使用 Pi API，并把 Pi 的行为转换成 Dock 协议。

创建 Pi session 时，adapter 固定启用 `extensionModelMutationPolicy: "legacy-defaults"`，保留既有插件 `pi.setModel()` / `pi.setThinkingLevel()` 的默认保存行为：切模型保存默认 provider/model 并保留当前 Thinking 偏好，只有发生变化的有效 Thinking 才写默认，非推理模型不会抹掉偏好，也不隐式扩大模型范围。该配置随既有 session factory 重建，不由 wire workerConfig 覆盖；Pi 的公开 SDK setter 仍保留 0.85 的显式持久化语义。插件同步 setter 只更新内存并排队写入，不是落盘回执，不能替代 Dock 原有的 `flush()` / `drainErrors()` 与 `settingsWrite.persisted` 合同。

Worker event/response 已携带完整 `modelState`。连接接收时捕获其变化与 generation，Host 通过既有 catalog transition 提交模型/Thinking，并用 `model.changed` 通知实时客户端；被动观察没有原始 requested level，不编造 `thinking.changed.requested`。显式 Dock 配置仍拥有自身完成和失败事件，期间观察到的最新状态在该提交后补齐、相同值去重；Thinking 请求若同时观察到模型变更，也发布模型事件。Session replacement 使用对应消息携带的模型状态，不能在异步提交时重新读取已经前进的 Worker 状态。

Model/Thinking 在手动或自动压缩期间可读、可设置。新选择用于后续调用，不自动取消或重跑已经开始的调用；设置的保存与失败回执沿用原合同。调度边界见 [instance.md](instance.md)。

默认压缩提示由 public SDK `getCompactionPromptTemplates()` 只读提供：`system`、首次 `summarize`、已有摘要时的 `update`、保留分段前缀的 `turnPrefix`。Protocol 的 `session.compaction.prompts` 及 `DockClient.compactionPrompts(instanceId)` 原样读取四项。它们不含动态对话/旧摘要，不能冒充当前 provider payload 或扩展实际自定义提示；补充说明另行编辑，且只追加到历史摘要任务，不替换完整模板。读取不触发压缩、模型调用或文件写入。

Agent/扩展也可直接导入同一 public SDK getter。Dock Agent 的 Bash 环境提供实际 bundled CLI 与 Node 入口，以下 POSIX 只读示例从该包的 ESM public export 读取，不依赖 workspace 恰好安装 Pi，也不假设私有 `dist` 路径或新增 Dock tool：

```sh
(cd "$(dirname "$ALU_DOCK_PI_CLI_ENTRY")" && "$ALU_DOCK_PI_NODE" --input-type=module -e '
import { getCompactionPromptTemplates } from "@earendil-works/pi-coding-agent";
console.log(JSON.stringify(getCompactionPromptTemplates(), null, 2));
')
```

消息提交的 input kind、实际 delivery 和 custody owner 都由 adapter 确定。调用者的 `auto / prompt / steer / followUp` 原样到达 Worker；普通 prompt 由 Pi input hook 再次检查运行状态后报告实际采用的 `prompt / steer / followUp`，registered extension command 则在 adapter 已解析并取得 invocation custody、但可能长时间运行的 handler 开始前报告。Compaction 期间不能交给 Pi 的普通 input 明确报告 Host custody。这个私有 preflight 是 Worker→Host 的事实通知，不增加逐条批准往返；Host 按 adapter 报告的实际 delivery 提交 receipt 和 Queue 状态；较早的 `isStreaming` 或 extension command 文本不作为 delivery 判断依据。`operationId` 贯穿直接执行和排队执行；只有确实进入 Queue 的消息才创建 `queueItemId`，也只有实际消费 Queue item 时才产生 queue-consumed lifecycle。Queue provenance 与最终 delivery 分开保存：compaction 期间由 Host 保管的 Queue item 可能在 Pi 恢复空闲后以 fresh prompt 启动，但它仍消费原来的真实 Queue identity；普通 direct prompt 则不会产生 queue-consumed。

Conversation projector 使用同一个实际 delivery 生成 `message.submitted`。已经被 Worker 接受的用户消息始终发布为 canonical conversation frame；Host 的辅助 Queue identity 关联异常时，消息仍须先出现在 conversation。

Conversation 的持久语义也在 adapter 内完成。Pi adapter 把当前 branch entry 投影成 canonical persisted record，显式保留 message、tool result、custom/custom message、bash execution、compaction/branch summary、model/thinking/session/label record 及其 visibility/metadata；Host 不读取 Pi role 或 Pi session 私有 shape。大型内容的 record 只承载有界 preview，完整内容由 conversation history/content 的 revision、content ref 和 chunk 提供。 默认读取的 `contentComplete` 只说明最终发出的 `content` 是否完整，metadata 的裁剪仍由独立的 omitted fields 表达；二次 preview 和整页字节裁剪后重新确认完整性。原生图片的 descriptor 保留给独立 image 读取路径，但未内联原始 bytes 的 preview 仍为 `contentComplete: false`，保留旧 Client 根据此布尔值调用 `conversation.content` 取得 image data 的语义；文本预算和整页裁剪不隐藏图片身份。Tool result 按原 item 顺序保留图文，只合并相邻 text 为一个 `tool_result`，绝不跨 image 聚合；只有 image 的工具仍保留空的 tool-result 身份块。显式 `view: "references"` 复用同一内容生产器，在原位置输出图片身份而不输出 data；该视图的完整性只比较文字、工具信息和图片引用。Pi 原始 JSONL 和图片读取不变，最近一条正文缓存由两种视图共用，continuation 只增加视图绑定。history 的 `totalBlocks` 与旧 `conversation.content` 的块布局一致，published file 仍在原 tool result 上。Adapter 与 Host 的 history 分页沿用 canonical `toolCallId` 关联完整语义单元，Assistant tool call 与已有的对应 results 必须在同一页。canonical 和二次 preview 的字节/正文预算先保留 tool 身份；args 放不下时裁为带 omitted fields 的身份块，不能删掉 tool call 使 Host 或 Worker 的关联断开。Worker 私有协议还限制整个 conversation history page 的传输字节数；adapter 应先去除可由 content ref 读取的 preview，而不是拆开语义单元。

Conversation 读取位置由 Worker 的当前 Session/branch 管理。只有确认 public SessionManager 的既有持久 entry 对象仍是当前 branch 的完整前缀时，追加才保留同一个 opaque revision 和既有 history/content 位置；同一次 descriptor/content 读取继续返回一致 revision，不改为每条记录的不同版本。旧 history 位置读取其已接受的前缀，不被之后追加的 tool result 改写分页边界。分支替换、Session 更换或 runtime rebind 则轮换读取域并使旧 continuation 失效；不可变记录的 content ref 不变。当前 branch 只长期保留原 entry 引用、ref 与工具身份索引；canonical preview 用单个现有 history page 字节预算的热缓存，另保留最近读取的一条正文视图（原文/图片字符串复用 source，工具多文本聚合与参数 JSON 可能生成新字符串），不按 scan 保存整份会话副本。图片登记事实按原生对象弱引用复用，preview 淘汰不要求重新 hash。当前 branch 同时保留 image ref→原 image 对象身份索引；有界 registry 淘汰后，独立 image 入口及旧 image content 入口从这个权威索引恢复弱登记事实，不复制原图、不重 hash，也不要求先读正文。完整语义页可超过 registry 的 handle 容量，逐图读取仍按需恢复；branch/scope 替换会释放旧索引，不能据此恢复非当前 source。未变 leaf 的正文续读不遍历重投影全 branch，也不重新 hash 所有图片。此行为需要采用修正后的 Worker 源码，不能热修已经运行的旧 Worker；不改变公开 Protocol V2 shape 或旧 image/content 读取能力。

实时事件与持久 record 不需要共享 identity。在线客户端在 `message_update`/tool event 上原位更新组件，完成后直接保留；重建时才从持久 record 重新生成。Adapter 在一个 turn、run、compaction 或独立持久写入形成安全边界后发出私有 `conversation_checkpoint`。Checkpoint 携带该边界的精确权威 branch history snapshot，表示它之前的 conversation frame 都已由这份 snapshot 表达；Host 原子安装 snapshot 并释放 active buffer，不能在稍后读取一个可能已经前进的 history 来猜测边界。Checkpoint 不等待任何客户端确认。

Pi 是当前成熟基底。真实工作需要且 Pi 已经具备的能力，应完整接入 Dock，跨进程适配保留其语义；各客户端按需实现界面，未来 Agent 按各自运行方式接入。

Pi Worker 自带 `/retry`，只在用户主动输入且最近一次模型响应失败、当前空闲时触发。命令使用公开的 extension `sendMessage` 进入 Pi 原有 Session 流程，并等待该轮结束；隐藏的 `alu-dock-retry` 标记保留在 Pi journal 里供识别，但由同一插件的 `context` hook 从模型上下文移除，因此不追加用户聊天指令，也不重放已经完成的工具。它不使用私有 SDK 补丁，不增加自动重试策略；Pi 原有重试、压缩和收尾照常生效。

项目状态的资源正文通过 `resource.content.v1` 读取。Pi adapter 为已加载的 Skill、Prompt、Project Context 及文件来源的 SYSTEM.md / APPEND_SYSTEM.md 生成 opaque `contentRef`；只有这些当前登记的资源可以读取，不接收客户端任意路径。Worker 经私有 `resolve_file_source` 将已登记资源的路径交给 Host，不读取或传输正文。Host 从磁盘当前 UTF-8 文件按字节续读，复用 source-file 检查，文件变化时要求重新打开，不保存正文快照、不执行资源或触发 Reload。全局文件不受 workspace 根目录限制；Project Context 中的 system 文件项只对应实际磁盘文件，Pi 内置生成提示不作为文件资源列出。

命令发现按能力而不是具体名称接入。Pi adapter 从公开的 loaded prompt template 保留 `argumentHint` 和可检查正文；正文分页来自内存中的 `PromptTemplate.content`，不让 Host 或客户端读取 `filePath`。Extension command 的动态参数候选由注册时的 `getArgumentCompletions` 产生，并通过同一通用结果体返回；Dock 自带 Extension command 也沿这条 owner API 声明候选，不在 Host 建名称表。Catalog 后续读取使用 `{name,source}`，按名称和来源共同确定目标。

Pi 的 abort 会等待 Agent 回到 idle；普通 `command.abort` 不动 Queue，已排队输入可以在当前输出终止后合法启动下一轮，因此 abort 的完成时间不是 Worker 存活探针。Host 不因 abort 尚未返回而切断 Worker。像 Pi TUI 按 Esc 一样“中止并把排队文本放回输入框”由 `command.abort_restore_queue` 一步完成：Pi adapter 在同一次 Worker 调用中先清空 Pi Queue、紧接着 abort，中间不给 Agent 取下一条的机会；Host 在同一个 interrupt 期间暂停把压缩期间暂存的消息交给 Agent（已开始的那一次交付先完成），停下后把 Host 暂存和 Pi 清出的消息按原顺序返回给调用者，并以 `queue.cleared(reason: abort)` 通知其他入口。已经被 Agent 取走的消息留在对话里，只在回执的 `inFlight` 中列出，不阻止中止。客户端不再先取回再中止。Compaction 只是运行中的暂停边界：completed 后 Pi 自己的 retry、extension/guard continuation 仍按原生顺序继续，Host-deferred Queue 在第一个合法时机自动交付，不能抢断 continuation，也不依赖任何客户端在线。

### Agent-facing Host capability pattern

Agent 通过 observation 已建立的 reverse-capability 形状访问 Host-owned 事实。该边界使用按能力定义的接口，不提供 Worker 直连、Host object proxy 或通用任意 RPC：

1. `src/core/` 定义一项 capability-specific HostPort 与 Dock 已有 DTO；
2. Registry 在创建/reopen Worker 时注入 HostPort；
3. `AgentWorkerConnection` 只从已认证连接上下文取得 `sourceInstanceId`，并继续使用 host epoch、runtime generation、worker incarnation 和 ordered private envelope fencing；Worker request 不能自行声明 caller identity；
4. Worker bootstrap 只在 Host 授予对应 `dock.*` capability 时建立一个小型 bridge；
5. Agent adapter 用 inline extension/tool 或其他 runtime-native API 暴露能力；使用说明可随包提供为 Skill 或按需阅读的工具手册。

每项能力保留自己的 closed request/result、bounds 和开关规则。公开业务 DTO 统一在 Protocol V2 定义一次；private envelope 只验证 source binding、路径等 Host-private fact 和跨进程边界。

`dock.attachments` 是这个 pattern 的第二个实现，而且始终随 managed Worker 提供。`command.submit` 的 full attachment metadata 通过 private invoke context 与公开 file IDs 做逐项一致性检查；Pi adapter 把一个明确的 untrusted metadata block 放进原生 prompt，同时在 live/history projection 中恢复干净文本和 `AttachmentDto[]`。该内部 block 由 Worker 使用 agent state 中持久、`0600` 的随机 key 做 HMAC 认证；普通 prompt 即使复制相同文本形状也不能伪造 attachment provenance，认证失败的文本不会被静默剥离。Host path 不进入 invoke context、Queue 或 conversation。

Pi inline extension 提供 `dock_attachment_list` 和 `dock_attachment_resolve`。list 只返回 path-free metadata；resolve 通过当前 authenticated Worker 的 reverse call 让 Host 检查文件后，把一个 absolute path 只交给 Agent tool result。外部 conversation projector 对 resolve tool text 做固定 redaction，structured details 也不含 path。Bundled `dock-attachments` Skill 指导 Agent 在修改、转换或解压前，把原文件复制到 workspace 或临时目录并保留永久原件；文件名、media type 和内容一律是不可信数据。普通 resolve 只返回工具所需的文件路径，不调用 Pi image loader；文件访问权限以 Host/Worker 所用的同一 UID 为边界。

当 `command.submit` 的 authenticated attachment context 含 `image/*` metadata 时，Pi adapter 在真正 delivery 前经同一个 attachment reverse capability resolve 每个图片 fileId，把 private Host path 只转换为本轮 Pi 原生 image input，同时继续把完整 attachment metadata 放进已认证的 prompt context。显式 image 与 attachment-derived image 共用 Pi 已有的数量、单图和 aggregate bytes 检查；Dock 不维护 model/provider 视觉能力表。SDK 事件转换仅在 Worker 内保留后续匹配所需的 SHA-256，先认证附件上下文再裁剪用户文本，不在公开 image block 增加 hash、bytes 或 path 字段。Pi user message 中图片 bytes 的 SHA-256 与已认证 `AttachmentDto.sha256 + mediaType` 相同时，live/history projector 给 image block 加上对应 `fileId`；它不删除 image block 或 attachment，也不把 Host path 放进 Worker result、Queue 或 conversation。

Dock 通过 Pi resource `extensionsOverride` 明确持有 canonical inline `show_image`，只移除其他 extension 注册的同名 tool，不依赖修改用户的 `~/.pi`。tool 只把 `{path}` 登记到 Worker-local generation/session registry，Pi session 不持久化图片 bytes；live 与 history projector 从 structured details 产出同一个 path-free `PublishedFileDto`。`file.read` 由 Host 通过私有 `resolve_file_source` 向当前 generation 的 Worker 解析登记引用，取得发布时冻结的文件身份后直接读取；Worker 不返回文件字节。来源解析和整个读取共同受 Host 的查询、会话替换和停止检查保护；公开分页形状不变，Host 不另存登记或文件副本。原生 Pi ImageContent 在 live 与 history image block 上发布同一个由 immutable decoded bytes SHA-256 决定的 content ref；同 bytes 在 append、refresh 和 Worker restart 后保持 identity。既有 image block 与 `conversation.content` 形状保持不变，避免破坏已发布的 Protocol V2 客户端；新客户端通过单连接 `conversation.image` stream 的 ready frame 获得 canonical lowercase SHA-256 与 decoded size，再以 callback 读取 bytes。这里没有 provider context hook。

Pi Worker 内建 `/dock-tools on|off|status`。开关按来源 instance 持久化，默认关闭；新建、adopt 和从别的来源创建的 instance 都不会继承。`dock.tools.configure` reverse capability 始终存在，Host 在开关为 on 时授予 `dock.tools`。开关通过 Pi 原生 `setActiveTools` 更新可用工具及其提示，off 时这些工具离开 active set。使用手册随包保存在 `docs/agent/dock-tools.md`，由各工具的 description 提供实际文件路径，Agent 需要时读取；它不注册为 Pi Skill。切换开关不执行 resource reload，正在进行的调用继续使用有效上下文。用户主动 reload/rebind 时，开关仍从 Worker-level capability state 恢复。

开关开启后恰好提供：`dock_list({scope?: "live" | "all"})`、`dock_machines()`、target 必填的 `dock_inspect`、`dock_watch`、`dock_cancel_watch`、`dock_deliver_file({path})`、`dock_system({cwd,machine?,id?,cursor?,offset?,revision?})`、`dock_create({cwd,name?,machine?,systemId?,saveDefault?})` 和 `dock_send({target,message})`。list 只读短状态，不拉取 conversation；inspect 才按需读取一个按消息条数分页的 conversation page。Agent-facing client 把 canonical message page 渲染成 `target_user / target_assistant / target_other` 引用流，每行 sibling 内容都处于明确的 untrusted quote 边界；结构化 DTO 只留在 tool details，不把 JSON、TUI reconnect event、thinking、tool call/result 或 Host metadata dump 放进模型上下文。`limit` 只限制一次返回的消息条数，选中的消息正文保持完整；若底层传输无法承载则明确失败，禁止返回截断内容。默认读取最近一条，Agent 只有在主人需要更早内容时才使用 continuation cursor。

`dock_deliver_file` 只接受 absolute path。Host 从 authenticated Worker connection 取得 source instance，把 readable regular source 的 path 与 identity metadata 暂存在当前 `ManagedInstance`；它不在 registration 时读全文、hash、复制或持久化。最多 100 MiB（含边界），跨 Pi session replacement 保留，stop/Host restart 后消失；已有登记不因 `/dock-tools off` 删除。公开 list/download 只含 path-free `DeliverableDto`，bytes 由 Host 专用 stream 直接送给客户端并用 terminal SHA-256 核对，始终不经过 Worker。`show_image` 继续使用独立的 Worker session-scoped inline image 语义。

`dock_machines` 沿 Main 的同一 Machine authority 返回名称、availability、platform、Home 与 workspace roots，Agent-facing 文本省略内部 `hostId`；Machine 名称和路径按不可信 metadata 呈现。`dock_create` 接受 absolute cwd、可选名称和可选的精确 Machine display name；省略 Machine 时创建在来源 work 所属 Machine，提供时由 Main 将唯一名称解析为 `hostId`，再沿 Host 的 canonical `instance.create(hostId)` application service 创建。找不到、重名或离线都明确失败，不让 Agent 输入或看到 Machine UUID；新 instance 的 Dock tools 仍为 off。`dock_send` 先把 human-readable source display name 与固定来源说明包在正文外，再沿同一个 `command.submit` application service 使用 `delivery: auto`；因此目标的运行中/空闲判定、Queue、receipt、持久 conversation 与普通 user message 完全一致。包装明确标注消息来自另一个 Dock instance，正文逐字保留，来源使用人类名称并省略 UUID。Dock tools 不提供 stop、interaction answer 或任意 Agent 私有控制。

watch tool 只登记 Host subscription 并立即返回。Host completion 通过私有 `observation_delivery` control 到达当前 Worker；completion 只含 target/reason/time，不携带 sibling conversation。adapter 写入可见的 `dock-tools-watch` custom message，并用 Pi public `sendMessage(..., { triggerTurn: true, deliverAs: "followUp" })` 唤醒 Agent；Agent 醒来后按主人原始意图决定是否 inspect。watch completion 使用上述独立投递路径，不走用户消息的 `command.submit`。reload 的短暂无 binding 窗口由 Worker bridge 有界暂存 completion；cancel/off 会先在本地 fence pending delivery，同一 watch ID 至多唤醒一次。Dock tools 手册说明按需读取、等待、创建和消息来源边界，入口随启用的工具描述提供。

## Extension UI

Extension component 和 Promise 留在 Worker。Worker 负责 component render、input、invalidate 与完成回调；Host 负责 generation、当前操作者和定向路由；TUI 或 WebUI 负责各自支持的显示与输入。读取和实时跟随不取得操作权；新的操作连接会立即替换旧连接，但不会取消 Worker 中等待的 interaction。

会话替换的 UI 交接由同一生命周期控制：Worker 暂存新插件初始化期间的单向 UI 更新，在发布 `dock_session_replaced` 后按顺序释放；Host 在收到替换事件时立即使旧 UI 失效，不等持久化转换队列才清理。这样新状态不会被后续收尾清空。取消替换不进入交接，失败则丢弃暂存发布；同一 session 的插件 `ctx.reload()` 在原有重置完成后释放新状态。暂存范围仅包含新插件发布的 UI 更新；Work 的 Dock tools 授权保持独立，不参与迁移。

某个客户端尚未支持的 Extension UI，只在该客户端不可用；extension runtime、Agent 和其他客户端继续运行。客户端不得代替用户生成回答。

Extension command 仍通过完整 Agent input 语义执行，不另建第二条命令通道。Worker 在执行前确认当前输入确实命中已注册的 Extension command，并只在该 handler 尚未结束时，把同一次提交已有的 `operationId` 附到 `extension.notification`。它只表达来源关联：通知仍不是 conversation record。handler 返回后遗留的 timer、后台任务以及其他被动 Extension 通知不携带该 ID；Host 不按文本、时间或命令名称猜测来源。

## 新增 Agent 或能力

新增使用现有 Dock 能力的 Agent时，只增加 Worker adapter 和 runtime kind 注册，不修改 Pi adapter和不相关客户端。

Agent 出现新的真实能力时，在 Protocol V2 定义一次，由提供该能力的 Worker adapter 产生，再由需要它的客户端实现。Host 只有在这项能力确实增加新的控制或生命周期规则时才需要变化。

## Pi SDK 升级

频繁的 Pi 版本升级使用独立的[兼容性准入门](../pi-sdk-upgrades.md)，不混入普通测试套件。入口是 `npm run test:sdk-upgrade`，场景实现在 `test/pi-sdk-compat/`；它经过真实 Dock/Worker/Pi public SDK 边界，但只连接本机确定性 transport，不访问外部模型。

## 代码范围

- `src/pi/`：当前 Pi Worker、Pi adapter、Dock capability extensions 与 Worker 进程实现。
- `skills/dock-attachments/`、`docs/agent/dock-tools.md`：随包发布的附件 Skill 与 Dock tools 使用手册。
- `src/control/`：Host control、Worker supervision 与 session routing。
- `src/core/`：Dock 自己的协议数据与跨实现概念，不依赖 Pi runtime。
- `src/tui/`：本机终端客户端（通常经 SSH 使用），不持有 Agent runtime。

具体实现按以上边界组织。出现跨层重复定义或投影时，先将能力收敛到所属层，并复用 Protocol V2 的同一定义。

`dock_system` 通过同一 Protocol 查询目录候选或分页读取原文件；返回正文与元数据始终作为 untrusted task data 引用。`dock_create` 显式选择覆盖目录默认；未选择时交给创建 Host 应用目录默认，未配置才用 Pi 原生行为，已配置但损坏则明确报错，不创建首项。`saveDefault` 是独立明确保存，必须提供显式 ID，不开放 generic workerConfig。来源授权和新 Work off 规则不变。
