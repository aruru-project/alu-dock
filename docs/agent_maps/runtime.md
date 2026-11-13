# Agent Worker 与 Runtime

## 这部分负责什么

Agent Worker 负责运行真正的 Agent。当前有两种：Pi（除助手以外的每个 Work），和个人助手自己的 Agent（以助手身份打开的 Work，见[个人助手](#个人助手)）。还可以增加其他 Agent adapter。

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

Pi 继续唯一拥有 `~/.pi/agent`（或 `PI_CODING_AGENT_DIR` 指定目录）中的 settings、`models.json`、`auth.json`、packages/extensions 和 `sessions/`；其中模型配置和凭据只用 Main 那一份，见[模型配置与凭据](#模型配置与凭据)。Dock 不创建 Profile、凭据副本、配置投影、导入流程或另一处 Session root。Managed Host 没有调用终端的 shell environment 时，会在启动时从用户 login shell 解析一次 Pi 原生 agent directory，但不保存 Dock 副本；解析结果同时供 inventory 和 Worker 使用。Host 解析出的 Pi `agentDir` 会作为 Pi 自己的环境契约传入 Worker，因此默认 Session 路径、nested Pi 与 `aludock pi:install` 仍指向同一份 Pi 环境；project `.pi`、`.agents`、Project Trust 与 Pi precedence 继续由每个 Worker 原生加载。

本机 Hub 通过 bundled Pi 的 public model/auth API 读取当前 Providers、models 与非秘密 access 状态，并让 Pi 自己执行 API-key login、OAuth login/logout 和 token persistence/refresh。`aludock pi:install <source>` 直接调用 bundled Pi package manager 并写入 Pi 的 global package settings；source 只承诺 Pi Package conventions。`aludock update model` 在 Windows/Linux 都直接调用 bundled Pi 的公开 `ModelRuntime.refresh({ allowNetwork: true, force: true })`，由 Pi 更新自己的持久模型目录；Dock 不复制下载、解析或合并逻辑。现有 Worker 不被 Host 热改配置，用户通过 `/reload` 采用 package/model 环境变化。普通 `/reload` 与插件 `ctx.reload()` 在新插件注册完成、`session_start` 前，调用 Pi 的 `ModelRuntime.refresh({ allowNetwork: false })` 重读本地 `models.json` 与已下载模型目录，再更新当前和 scoped model 引用；不为模型目录刷新访问上游，不主动切换当前模型。`/new` 与 resume 沿 Pi 原有 session replacement 重建本地模型环境，Worker 进程不变。

Work 的 `model.list` 与 Host 设置页使用的机器级可选模型列表共用 `src/pi/pi-model-list.ts` 的投影、排序和上限。后者由 Host 启动一个短命进程（`pi-model-catalog-entry.ts`），以和 Worker 相同的 login-shell 环境、`agentDir` 与启动身份（`enterPiWorkerRuntime`，extension 经 `process.argv[1]` 启动的是 Pi CLI）加载 Pi 的全局配置和 extensions，答复一次 `getAvailable()` 后保持存活，由 Host 结束它连同 extension 启动的整个进程树；extension 代码不进入 Host。隐藏列表由 Host 在返回前过滤，Worker 和 Pi 不知道它，见 [control.md](control.md#模型隐藏列表modelvisibilityv1)。

每个 Pi Worker 的 resource prompt 会追加稳定的 Alu Dock 身份说明：它知道自身是由 Dock 管理、终端断开后 Work 仍可继续，并知道 Pi 原生配置与 Session 仍归 Pi。`ALU_DOCK_PI_WORKER=1` 只是私有进程 bootstrap marker，不是 Agent 的产品身份接口。

`instance.create` 可携带 bounded JSON `workerConfig`。这个对象在 generic Protocol/Host/catalog 中保持 opaque，随 durable reopen 原样交给选中的 Worker adapter；Host 不枚举字段、不把 Pi option 提升为 Dock 语义。Pi adapter 把其中 JSON-safe create fields 交给 Pi 的 session constructor，Worker-owned services、SessionManager、identity 与 transport 不能由该对象替换。不同 Agent adapter 可以按自己的原生 contract 解释同一容器。

`workerConfig.model` 是 `{provider,id}`，不是 Pi 的 Model 对象；adapter（`src/pi/pi-starting-model.ts`）在每次构建 session 时按 Pi 的 `modelRuntime.getModel` + `checkAuth` 解析，语义同 `pi --model`：它是这个 Work 新会话的起始模型（创建、`/new` 都适用），不写入 Pi 的默认模型；会话已经记录自己的选择（model_change 或已有回答）时沿用会话，所以在 Work 里切过模型后 reopen 或 resume 不会被创建时的选择覆盖。模型不存在或未登录时以 `AgentModelNotFoundError`（wire `model_not_found`，与 `model.set` 同一失败）结束启动。Worker 构建 adapter 失败时先发 `fatal` envelope 再退出，Host 因此拿到真正的原因而不是退出码，选中 system 不可读等启动失败同样受益。

### 显式 system 来源

Pi provider 生成 `workerConfig.systemSelection`：原生 `project-system`/`global-system` 保留 custom 文本语义；`dock-template` 是 fork SDK 的 `DefaultSystemPromptBody` 五字段 JSON（`intro/toolNotes/guidelines/documentationHeading/documentationInstructions`），不是最终组装 prompt，也没有占位符语言。项目来源同时保存原始 cwd，Dock 模板保存发现时的原始 Home（限定其 `.aludock/systems/*.json`），避免 session replacement 或 Worker 登录 shell 改变 HOME 后重新发现或拒绝原来源。模板选择必须携带来源 Home；没有 systemSelection 的旧 Work 继续使用原生行为。

Adapter 在创建 resource loader 时注入 `systemPromptResolver`，每次加载读取固定选中文件并同时返回 custom/default 内容及实际 `source.path`；显式选择覆盖项目 SYSTEM，但 APPEND、context、skills、动态 tool prompt 继续由 Pi 原生组装。读取或校验失败明确失败，不把路径当正文、不回退。Host 不解释这个 workerConfig。配置随 durable catalog/reopen 原样保留，工具重建不查询目录默认；没有配置的旧 Work 保持原生行为。

既有 `resource.get`/`resource.content` 自动使用 loader 的实际 source，所以 Work 读到的是选中的 JSON 或原生 SYSTEM 文件，而不是被覆盖的项目 SYSTEM，也不是最终组装快照。

## 模型配置与凭据

整个集群的模型配置和凭据只在 Main 上（card #303）：Main 的 `models.json`、已保存的模型目录（`models-store.json`）、`auth.json` 和登录。每个 Work 仍用 Pi 自己的代码组装请求、发送、处理回复，只是这些配置和凭据向 Main 要；回复不经过 Main，各 Work 只处理自己的回复。

- **Main 的模型服务**（`src/model-service/`）：Host 监管的独立进程，持有 Main 上 Pi 的 `ModelRuntime`，只回答三个问题：模型配置（`models.json` 原文与已保存目录）、凭据状态（哪些供应商已配置、哪些模型可用）和一次凭据。订阅登录只在这里刷新，Work 拿到的是短期令牌（GitHub Copilot 是换好的 Copilot 令牌和地址），不会拿到刷新令牌；普通 API key 原样给，只在内存里。服务崩溃时 Host 重新拉起，正在进行的回复不受影响。
- **Worker**：Host 授予 `dock.models` 时，Worker 用 Pi 分叉的 `ModelRuntime.create({ owner })` 建模型运行时（`src/model-service/owner.ts`），不读本机的任何模型文件。Pi 所有取凭据的地方都经过 `getAuth`，包括扩展通过 `ModelRegistry` 自己调模型时，所以一并问 Main；改写请求的 hook 照常在 Worker 里运行。每个 session 新建一个运行时，扩展注册的供应商不会跨 session 残留。Main 在运行时里答复之前，它定义的供应商一律问 Main，不退回本机。
- **路径**：Worker 只问自己的 Host（`dock.models` 反向调用）；Main 上的 Host 转给模型服务，SubHost 的 Host 经机器连接转给 Main（见 [control](control.md#main-与-subhost)）。问题等服务或连接最多 15 秒，等过一次后立即失败，直到恢复；取消立即放开调用方。
- **例外**：只由扩展定义、Main 上没有的供应商用扩展自己的凭据；扩展只是给内置供应商或 Main 配置里的供应商加东西，不算。Bedrock、Vertex 的云账号由 Pi 在 Work 所在机器读取，Main 交不出去（用户 2026-11-05 接受）；它们能不能选仍由 Main 的凭据状态决定，所以两边都要配。
- **机器连接**：Main 对同一台 SubHost 的回答一次发一份，配置的回答接近链路控制队列的上限，而那个队列满了拒绝、不等。SubHost 等一个问题的完整回答最多 120 秒，未答的问题最多 1024 个，回答累计不超过 `MAX_MODEL_ANSWER_BYTES`；断开或停止时未答的问题都失败。

## 个人助手

阿露是 Main 自动打开的唯一常驻助手（#295、#667、#670），运行方式与记忆均不属于 Pi 编码 agent。生命周期和旧会话迁移见 [control](control.md#个人助手assistantv1)。

- **助手服务**（`src/assistant/`）：Main 上 Host 监管的独立进程，和模型服务共用 `src/control/service-supervisor.ts` 的启动、重启与问答。它持有 Host 私有状态目录下 `assistant/` 里的人设 `persona.md`、主人的手写设定 `notes.md` 和 Node 自带 SQLite 的 `memory.sqlite`。人设文件不存在时用 Dock 自带的阿露人设新建，已经存在就不再覆盖，升级也不动。对话原文每条记着 Agent 的 session ID 和 entry ID、分支上的前一条、时间、所在 Work（Main ID）和机器；条目的行号按时间排（毫秒时间 × 1024 加序号），全文索引（SQLite FTS5 trigram）共用这个行号，时间范围就是行号范围；同一毫秒超过 1024 条时多出的用下一个空着的毫秒的行号，库里记着最多顺延过几毫秒，时间范围的上端按它放宽，再按每条自己的时间过滤；搜索沿行号往下走时，读到的条目要等走过它自己的那一毫秒才交出，所以时间范围和从新到旧的顺序都按实际说话的时间算（同一毫秒内按行号），续读位置是“时间 + 行号”。一次搜索或读前后文在同一个读事务里完成，看到的是同一份已提交的数据。条目时间只收 1970 年前后约 ±253 年（`ASSISTANT_TIME_RANGE_MS`），超出的在入口拒绝。三字及以上的词走索引，一两个字的词用 SQLite `LIKE` 比对（只有英文字母不分大小写）。搜索都从最新的往回走、凑够就停：只有索引词时只走索引；有一两个字的词或只按时间时，每次读 5000 行再检查截止时间。写入只在服务主线程用一个连接，一次一批（整批 JSON 不超过 `MAX_ASSISTANT_RECORD_BATCH_BYTES`，入口也检查），失败时保留原始错误；条目的 `parentId` 不是这个会话已经存下的条目时不存。搜索和读前后文在固定两个读线程上，各用自己的只读连接（WAL 允许边写边读）。Node 的同步 SQLite 不能从外面打断，结束线程也要等查询跑完（Node 24.22 实测），所以时限这样实现：提问方从提问起（含排队）15 秒收到 `assistant_query_timeout`；线程在下一步自己按同一截止时间停下，答复之前一直算忙、不接新活，迟到的结果丢弃，线程数不会变多；排队最多 32 个，再多直接回答“正在处理很多查询”。线程出错退出时 1 秒后补一个。数据库带结构版本号，打开时先看版本再建表：空文件才初始化，读到不认识的版本（或有表却没有版本号）就拒绝启动、原样保留。提问方等到截止时间、排队时到期、线程答复时已过期，都按超时答复；线程开始任何查询前也先看截止时间。服务收到 SIGTERM 时关闭数据库再退出。她自己的记忆工具只记下做了什么（工具名和 `action`/`document`），参数和结果不记：那些内容本来就在她的记忆和对话里，忘掉时才能一起忘掉；也就不会被旧搜索结果反复命中。Pi 的会话文件不改。人设和手写设定经服务保存时不会互相覆盖，替换前再核对一次版本，换完同步目录（Windows 不能同步目录）；但在编辑器里保存的同一瞬间服务也在替换时，编辑器的那次仍可能被覆盖，文件没有原子的“核对并替换”。
- **记忆**（`memories.ts`）：和对话放在同一个库里。每条一件事，带分类、是否每次载入（常驻）、状态、最近一次改动的来源、版本号、出处（指向对话条目）和说起的时间（出处里最早一句的时间，随着出处增加往前挪；没有出处的才是写下的时间，列表可按它筛日期）；每次改动留一行记录。什么都不真删：作废是 `retired`，忘掉是 `forgotten`，都能恢复。一条记忆被忘掉时，它出处的那些条目也搜不到，读前后文只显示“这一条主人让我忘掉了”（条目上记着有几条被忘掉的记忆藏着它，归零就回来）。按对话里的位置说着同一件事的条目跟着一起藏（`memory_hides`）：对出处的回答（同一轮里她接着说的话、工具结果和提示，各个分支都算，到主人、别的 Work 再开口或主人自己跑命令为止）、主人让她忘掉的那一轮（她的工具报上位置；那一轮还没记到 Main 时先记下位置，到了再藏；已经忘掉的记忆再被要求忘一次，新的那一轮同样藏起）、以及之后 Pi 给这段对话写的摘要；忘掉之后才记下的回答和摘要同样藏起。摘要到此为止：摘要后面的话不因为摘要被藏而跟着藏。覆盖这些话的时间线行也一起忘掉（见下；摘要不带走时间线行）。别处另外提到同一件事的原话不动，这一点界面和她的工具说明都写明；被忘掉的记忆留在库里，后台查得到，不会再记一遍（见后台整理）。恢复时这些全部回来。新会话载入人设、手写设定、全部常驻记忆（按分类列，带编号）和最近一周的时间线（见下，最多最新 40 行，从早到晚，放不下时写明）；常驻记忆不设单独的总长度上限，整份载入内容只受一条记录能带的大小（`MAX_ASSISTANT_PREVIEW_BYTES`）限制，超出时截断并说明。她在对话里用 `assistant_memory` 记下的一条，默认出处是主人在这个会话里最近的一句话（先把对话送到 Main 再记；别的 Work 发来的话不算主人的话）。
- **时间线**（`timeline.ts`）：记忆之外的第二层，回答“那天我们在干嘛”。一行是一个会话里的一段，写那段时间他们在做什么、聊什么，工程上的事照实写（在哪个项目做什么、卡在哪、做完没有），不挑重要不重要；起止时间是它覆盖的第一句和最后一句说出的时间，不经模型判断；第一句的位置随行一起给出，她和客户端从那里读原话。提炼读一段对话时顺手写：把这个会话最新的几行给模型看，同一天同一件事就改写那行（时间范围只往外扩，不丢原来说的），换了一天或换了话题才加行。读过的每一段都要落在某一行上：模型要改写的行不能改时（主人改过的、没给它看过的），那一行保持原样，这次读到的另起一行；模型的回答一行都没写时按“看不懂”处理（重试，三次后跳过并记下）。它要改写的行在它读的期间被改过时，它是照着旧样子写的，这次回答整个不采纳，这一段按现在的时间线重读。状态只有在用和忘掉，忘掉只是不再列出、不再载入，覆盖的原话不动，能恢复；主人改过的行后台不再改；不留改动历史，改坏了主人重写，原话都在。做梦不碰时间线。一条记忆被忘掉时，覆盖它出处的行也跟着忘掉：行里可能说着同一件事，后台又不能不经模型改写它，所以整行收起，宁可多忘一行，也不让忘掉的事留在开会话就载入的时间线里；`episodes_forgotten_with` 记着是哪条记忆带走的，记忆恢复时，没有别的被忘掉的记忆还压着的行一起回来；期间主人或她手动恢复、忘掉过的行，按那次的决定。
- **后台整理**（`extraction.ts`、`extraction-prompt.ts`、`model-access.ts`）：用助手设置里选的模型，在 Main 的助手服务里做，一次只做一件事，没选模型就不做。只读说过的话：主人的、她的、别的 Work 发给她的（`SPOKEN`），每句整句读，不读工具输出、她调了哪些工具、压缩摘要和插件提示（主人 2026-11-10 定：摘要只是把前面的原话换个时间再说一遍）；这些原文照样存着、能搜。等着读的字数也只算这三种。两步：一段对话 10 分钟没有新话（或者攒了很多）后，“提炼”按顺序一段段读它（一段最多约 24,000 字，再长的一句单独成一段；带前面最多 3,000 字做上文，太长时留结尾），新增、改写或作废记忆，每条注明出自哪几条，同一次回答里顺手写时间线（见上）；别的 Work 对她说的话标成“Work 消息”给模型读，可以写进时间线，但不当成主人的话或主人的情况记进记忆；会话上记着读到哪一行。几个对话都等着时，未读的话最早的那个先读，所以记忆按说话的先后形成。模型只拿到常驻记忆（和她开会话时一样），别的记忆让它用 `search_memories` 自己查（按字面匹配，一次几组词，最多 3 轮），查到的和列出的才能改写或作废；不再把一大批记忆塞给它（主人 2026-11-10 定）。查的时候也看得到主人让她忘掉的、以及主人或她作废的记忆，标明“别再记”、不能改：否则重读旧对话（比如从头整理）会把主人不要的事再记一遍。模型仍然新加、改写或合并出一字不差的同样文字时不采纳。后台自己作废的（合并掉的、从头整理收起的）不在其中。人设和手写设定整份给。模型的回答看不懂时同一段最多试三次，然后跳过、记进 `skipped_parts` 并在状态里说明，换一个模型时用新模型重读这些段（重读时看到的时间线是那段时间的，不是之后的）。一段的调用失败后，立刻问模型一句几个字的话（只在调用失败后才问）：它答得出，说明现在连得通；同一段连续三次都这样，并且这期间模型读成过别的段，才认定问题在这一段（比如内容被服务商拦下、超出上下文），跳过并记下。它答不出就是模型服务本身不通；一段都读不成则是每次整理都带着的东西出了问题（模型、它的设置、人设的长度）。这两种都不算在哪一段头上，不跳过任何一段，只是越等越久地重试。一段调用失败后先读别的对话，轮到它再试，所以一段读不成不会让后面的对话排不上；几段都失败过时，等得最久的先重试，轮流来。所有地方 30 分钟没有新对话、且有 20 条以上记忆被提炼或她改过（或者距上次已过 12 小时）时，“做梦”把这些记忆连同全部出处原话（整句，一次最多约 40,000 字，放不下的下次再看）和常驻记忆再看一遍，别的记忆同样自己查：记错的改正，重复的合并（合并后的那条带上所有出处，旧的作废并指向它），把只是细节的从常驻里拿掉。提示词讲清记忆是为了什么、让模型自己判断什么值得记，只把不能越过的线写成规矩（不记密钥，不记要她忘掉的，手写设定优先，标明出处）；工程细节不进记忆，但主人这阵子在做什么项目算他生活的一部分，照常判断值不值得记，做了什么本身写在时间线里；这借鉴了 Anthropic《Components of agent memory》：给强模型定死“记什么”反而记得更差，每次载入的部分越精简越会被照做，事后对照原始对话能改正记错的。两步都不动主人最后改过的记忆，主人定过是否常驻的也不改这个设置；应用前核对每条记忆还是不是模型看到的那个版本，期间有人改过就跳过这一条（同一次回答里先后改同一条不算冲突）；等回答期间有东西被忘掉（一条记忆，或时间线的一行）时，模型看到的原话、时间线或记忆里可能正好有这件事，它写出的任何一行、任何一条都可能带着它：这次回答整个不采纳，按忘掉之后剩下的重做一遍（做梦同样）；这次调用失败或回答看不懂时，也不算在这一段头上。连续失败时下一次尝试按 1、5、15、30、60 分钟退避，状态和原因在 `assistant.info` 里；有一次成功就从头算。主人可以“从头整理”（`reorganize`）：后台整理出、没人碰过的记忆作废（记成后台作废的，重读时可以重新形成；主人自己作废或让她忘掉的不会被重读带回来），后台写的时间线行删掉，跳过的段清掉，所有对话从头按说话先后重读；正在进行的那次提炼或做梦结果作废，不会接着写；时间线行带“手动改过”标记（主人或她改过一次就一直算），从头整理只删没标记的，行号不复用。已开着的助手 Work 不受影响，下次 Reload、重新打开或交接记录换进去时载入最新的。模型调用和 Work 一样：助手服务通过 Host 向模型服务要模型设置和凭据（`service-supervisor.ts` 的 `askHost`），请求自己发出，用 Main 上 Pi 的代理设置。调提示词时用 `scripts/assistant-memory-cases.ts` 里编造的对话跑 `npm run eval:assistant-memory -- --model PROVIDER/MODEL`：它用本机的 Pi 登录真调模型、要花钱，只在主人同意后运行。
- **路径**：只有助手 Work 的 Worker 被授予 `dock.assistant`。她只住在 Main，Worker 问 Main Host，由 Host 转给助手服务并标上 Work 和机器名。机器连接仍识别旧版本的助手问答，但新 SubHost 不创建助手 Worker。Worker 不能自报来源。客户端的 `assistant.*` 请求在 Main 上变成同一组问题，只有这条入口标明是主人问的（`owner`），改动才算主人的；其余一律算她的，包括 Main 一时对不上号的 SubHost Work，所以来源不全的问题不会带着主人的权限。
- **她的 Agent**（`src/assistant-agent/`，card #667）：以助手身份打开的 Work 不运行 Pi 的编码 agent。它的 Worker 用 Pi 的三样底层东西：`SessionManager` 保存对话（Pi 的会话文件格式，所以早先由 Pi 运行的助手会话照样能打开），`ModelRuntime` 取模型配置和凭据（与 Pi Work 相同，见上文），pi-agent-core 的 `Agent` 跑“问模型、执行工具、再问”的循环。项目的 AGENTS.md、SYSTEM、Pi 扩展、MCP、skills 和 shell 工具不加载；文件只读工具用 Pi public factories（read/ls/find/grep），不带写入或执行工具。对话交给 Host 用的是 Pi Work 的同一份投影（`src/pi/pi-conversation.ts`），送到 Main 用 `recorder.ts`（原来 Pi 扩展里的那一份）。
  - **开头**（`opening.ts`）：第一次回复前向 Main 取“她会读到什么”，原样作为这次请求的 leading system message；不再追加写死的角色或工作约定，这些仅作为可编辑 persona.md 的出厂内容，已有文件不覆盖；会话文件里不保存 system message，每次构建上下文都用当时的开头。取不到时这一轮照常回复，开头如实说明，主人收到一条通知，之后每轮再取。Reload、Work 重新打开和交接记录换进去时重新取；别的时候沿用，所以提示缓存不变。
  - **谁叫醒她**（`wake.ts`、`reminders.ts`）：主人的消息走 `command.submit`；子 Work 的消息（`work_message`）、`dock_watch` 通知（`observation_delivery`）和她自己定的提醒到点，都写成对话里的一条消息（前两种与 Pi Work 同一种 `dock-work-message` / `dock-tools-watch` 记录，提醒是 `assistant-reminder`）。她空闲时它开始一轮回复，正在回复时在下一步加入这一轮。别的 Work 连续开始 12 轮回复后（主人说话或提醒到点重新计数），再来的 Work 消息只写进对话、不开始回复，主人收到一条通知，发消息的子 Work 也被告知。别的顶层 Work 用 `dock_send` 发来的消息仍是带来源行的用户消息，同样计数；超过时 Host 把这次提交记为“已处理、没有运行”。
  - **每轮的现状**（`status.ts`、`works.ts`）：每轮回复开头写入一条隐藏消息 `assistant-status`：时间、是什么叫醒了她、她派出去的子 Work 和她盯着或替主人开的 Work 各自的状态（来自 `dock_list` 的短状态，加上它们最近一次发来的话的第一行）、没到点的提醒；主人其余的 Work 只给个数。有空闲、不欠结果的子 Work 时加一句“活了结了就用 `dock_stop` 停掉”（每个子 Work 占一个进程，她又不会重开对话）。它留在对话里不再改动，客户端不显示，也不送到 Main，写交接记录时不给模型读。
  - **工具**：四个只读文件工具、与 Pi 共用定义的 `dock_attachment_list/resolve`（`src/worker/dock-attachment-tools.ts`）、五个记忆工具（`memory-tools.ts`）、`assistant_remind`，以及顶层 Work 的 Dock 工具（定义与 Pi 共用 `src/worker/dock-tool-definitions.ts`），不含 `dock_wait` 和 `dock_spawn` 的 `withContext`：她的回合总是结束后等消息叫醒，她和主人的对话也不抄给子 Work。保留 `dock_deliver_file`，让她验看并发布已有成果文件，不因此增加写文件或执行命令的权限。`dock_spawn` 的任务后面由程序附上主人这一轮的原话。Dock tools 的开关和 Pi Work 是同一个：她的 Worker 用同一个状态键（`DOCK_TOOLS_STATUS_KEY`）报告开关状态，命令列表里只有 `/dock-tools on|off|status` 这一条，按命令处理、不进对话；关着时工具仍在声明里（提示缓存不变），调用由 Host 拒绝，现状里写明她现在派不了活。`tool.list` 如实列出已注册工具及说明、参数和可用状态，不提供逐个开关；关闭 Dock tools 不影响文件与附件只读能力。发来的图片继续直接转视觉输入，文本附件可 resolve 后 read，PDF/ZIP 仍派子 Work 提取。
  - **工具扩展**（`tool-extensions.ts`）：Main 的助手设置显式列出 `{id,module,enabled,config}`，Worker 在启动和空闲 Reload 时加载本机 ESM 工厂。扩展只拿到 cwd、自己的 dataDir/config、通知和沿 Host 的确认入口，返回工具及可选 dispose；不暴露改写会话或接管循环的钩子。工具转换成现有 AgentTool，图片、更新、错误与取消仍走原投影。工具名冲突不覆盖，单项失败只显示在已有 `extensionStatus`；`tool.list.source` 用 `kind: extension`、`package: id` 标来源。配置不进模型和会话，`assistant_memory` 设置操作只返回整理记忆模型。代码是用户信任的本机代码，不是沙箱。`builtin-extensions.ts` 是 Worker 内工厂装配点；无扫描、下载或 Pi 扩展兼容层。使用和最小示例见 [助手工具扩展](../agent/assistant-tool-extensions.md)。
  - **一轮的边界**：一轮最多向模型请求 20 次；到了上限再给一次请求让她向主人交代，这一次里只有 `dock_send` 会执行。上游一时失败（pi-ai 的 `isRetryableAssistantError`）按 2、6、15 秒重试三次，失败的那次留在会话里、用 context edit 从上下文拿掉。回复期间到达的主人消息进她自己的队列（`queue_update` / `dock_queue_consumed`），在下一步加入；Stop 之后队列里的消息照 Pi 的做法开始下一轮，「取回 Queue」把它们拿回去。
  - **交接记录**（`handoff.ts`）：她的对话不重开。助手设置可改启动阈值、保留最近原话的量和完整写作提示词，Main 保存并返回唯一默认正文；Worker 不在后面追加不可编辑的写作规则，只另附原对话和旧记录。自动值仍是模型窗口的一半（最多 10 万 token）启动、保留启动值的 30%（最多 2 万 token）；等待阈值仍是启动值的 1.5 倍。实际保留预算取当前模型的自动启动值和所选启动值中较小的一个，留出较早内容（减 1）；手填保留量超过它时只收敛运行时目标，保存值不改，状态明确写出实际采用量与原因。切点仍按完整轮次，实际留下的原话可能更多。所有计算只在 Worker。每次整理检查异步读取 Main 的设置，聊天和切模型不等读取；首次没成功读到不整理、保留完整对话，已有有效配置后读取失败则沿用它并提示，下次检查重读。写交接记录时沿用当前聊天模型，开始后固定这一次的参数与提示词，修改用于之后开始的整理。后台写时她照常回复；写好后在两轮回复之间换进去，写成 Pi 会话的 compaction 记录，所以上下文和记录的投影都沿用 Pi 的。超过等待阈值才在下一次请求前等它（没有在写就当场写）。写失败不丢任何东西，按 5、15、30、60 分钟再试，主人收到一次通知。换进去的同时重新取开头。正在写、最近成功或失败、配置读取情况和实际参数通过已有 `ui.setStatus` 的「滚动整理」交给 Work，最近结果记在她自己的 session 中；官方设置页读助手 Work 的这份状态，可刷新，不另建状态接口。她不发 `compaction_*` 信号，主人的消息不会因此被 Host 暂存。
  - **客户端看到的对话**：从倒数第二份交接记录开始往后（没有或只有一份时是全部）。更早的内容留在会话文件里，用助手页的搜索找。原因是 Host 在每个存档点都拿整段对话，而她的对话不会重开。
  - **忘掉**：Main 因为“忘掉”而藏起的条目（助手服务的内部问法 `forgotten`，只在 Host 和 Worker 之间用），她的 Worker 在每轮回复开始前、Reload 时和交接记录换进去时查一次：还在她上下文里的，用 context edit 换成“这一条里的事主人让我忘掉了”（她的工具调用保留位置、去掉参数，这些调用的结果一并换掉）；正在用的交接记录如果写在这次忘掉之前，让模型把这件事从记录里删掉后重写一份。她在这一轮里自己执行了忘掉，这一轮结束后才处理，不改动进行中的回合。会话文件里的原话不动；恢复一条记忆不会把上下文里已经换掉的话换回来。
  - **不支持的请求**：新建、切换、fork、clone、树上跳转以“已取消”结束并通知主人原因；手动压缩报“不需要压缩”；`bash.run` 等报错并通知。Reload 保留对话，让她重新取开头并处理忘掉的事（Host 照常进入下一个 runtime generation）。
  - **状态**：提醒、她派出去和跟着的 Work 记在会话的 custom 记录里（`assistant-reminders`、`assistant-works`），Work 重新打开后还在；子 Work 活不过她的 Worker，重新打开后第一条现状会列出哪些已经不在了。
- **子 Work 与协作成员**：`dock_spawn` 和 `dock_create` 都只开普通 Pi Work，不带阿露的私人记忆。她只有一个，由 Main 创建。

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

## 一个 Worker 要回答什么

Host 不认识 Pi，只认下面这套约定。任何一种 Agent 的 Worker 照此回答，就是一个完整的 Work；`test/fixtures/plain-worker.ts` 是最小的例子（复述收到的话、把对话存成一个文件，Pi 特有的东西全部为空）。

**进程两头的公共部分**在 `src/worker/`，各种 Agent 共用，不在其中写 Agent 自己的规则：

- Host 侧 `createWorkerInstance`：一种 Agent 只交出两样东西，客户端看到的 `executor.kind/version`，以及怎样启动它的进程（入口文件、cwd、它自己的启动输入、要加进 workspace 环境的变量）。连接、身份核对、超时、事故记录、`ManagedInstance` 的组装都相同。Pi 的那一份是 `src/pi/create-pi-instance.ts` 和 `pi-worker-launch.ts`。
- Worker 侧 `runAgentWorker`（`worker-shell.ts`）：读 `ALU_DOCK_WORKER_IDENTITY` 和 `ALU_DOCK_WORKER_INIT`，先用 `dock.identity` 向 Host 核对身份并取得“这个 Worker 可以向 Host 要什么”，再让这种 Agent 构建自己（`create(init, host)`）。构建失败发 `fatal`，成功发 `ready`；之后把 Host 的请求交给 Agent、把 Agent 的信号和答复带上当前状态发回 Host；Host 断开或发来 `dispose` 时收尾退出。Agent 实现 `WorkerAgent`：`dispatch`、`control`、`subscribe`、`state`、`dispose`。

**状态**（`AgentWorkerState`，随 `ready`、每个信号和每个答复带回）：会话 ID、会话文件、是否正在回复（`isStreaming`）、是否正在压缩、当前模型和 thinking、token 与费用统计。`durableSessionFile` 是这个 Work 之后能凭它重新打开的文件：Host 把它记进 catalog，Host 重启或 Worker 崩溃后用它再启动一个 Worker（启动输入里带着这个文件）。没有它的 Work 不能恢复。

**提交消息**（`command.submit`）是唯一有先后约定的请求。Agent 必须在答复之前，通过 `preflight` 回调恰好报告一次这条消息实际怎样被收下：

- `delivery: "prompt"`、`custody: "runtime"`：现在就开始一轮。
- `delivery: "steer" | "followUp"`、`custody: "runtime"`：Agent 正在回复，消息进了 Agent 自己的队列。之后用 `queue_update`（两个队列现在各有哪些文字）和 `dock_queue_consumed`（哪个 `operationId` 被取走）让 Host 的 Queue 跟上。
- `custody: "host"`：Agent 现在不收（比如正在压缩或收尾），Host 把它留在自己的 Queue 里，等 `agent_settled` 或压缩结束后再交一次（那一次的 context 是 `host_queue`；Host 要求直接排进 Agent 队列时是 `force_queue`）。
- `success: false` 并抛错：拒绝，消息没有被收下。

答复可以等到这一轮结束才返回。一轮没有开始就答复、状态里也不在回复的，Host 记为“已处理、没有运行”。

**信号**（`subscribe` 发出的事件）：

| 信号 | 含义 |
|---|---|
| `agent_start {operationId?}` | 一轮开始；带上引起它的那次提交的 `operationId` |
| `agent_settled {stopReason?, error?, operationId?}` | 一轮结束。`stopReason` 为 `aborted` 记为中止，`error` 记为失败，其余成功 |
| `dock_conversation_frame {frame}` | 一帧对话，已经是 Protocol V2 的形状（`message.submitted/delta/completed`、`tool.*`、`bash.*`），Host 原样转发 |
| `conversation_checkpoint {history}` | 到这里为止的对话都已保存；带上当前完整的记录列表，Host 用它替换手里的实时帧 |
| `queue_update {steering, followUp}`、`dock_queue_consumed {operationId}` | Agent 自己队列的变化 |
| `session_info_changed {name}` | 会话改了名 |
| `compaction_start/end`、`auto_retry_start/end` | Agent 自己在压缩或重试，Host 据此显示状态、暂存输入 |
| `dock_session_replaced {...}` | 换了一个会话（新建、切换、fork、reload）；Host 进入下一个 runtime generation |

一帧对话里的文字有长度上限（`MAX_TEXT_CHARS`）。更长的正文只放预览，客户端经 `conversation.history` 取得 `contentRef`，再用 `conversation.content` 分块读全文。

**其余请求**（`AGENT_REQUEST_TYPES`，结果体用 `protocol.ts` 里同一个 parser 校验）分三种回答法：

- 读对话：`session.history`（当前全部记录，Host 在启动、改名和换会话后读）、`conversation.history`、`conversation.content`、`conversation.image`。
- 列表：`model.list`、`tool.list`、`settings.get`、`resource.get`、`command.catalog`、`session.list`、`session.tree`。没有这类东西的 Agent 回答空列表，客户端照常打开。
- 改动：`command.abort`、`queue.dequeue`、`command.abort_restore_queue`、`model.set`、`thinking.set`、`session.name`（要同时发 `session_info_changed`），以及换会话的 `session.new/switch/fork/clone/reload/navigate/compact`。不支持的直接抛错；换会话的请求在抛错前不能已经动过会话。

**Host 的私有控制**（`control`）：`activate`（Host 已开始听，启动期间攒下的信号现在发出）、`wait_for_idle`（等当前这一轮结束）、`work_message`（父 Work 或子 Work 发来的消息，或 Dock 关于子 Work 停下的通知）、`observation_delivery`（`dock_watch` 的通知）、`resolve_file_source`、`resolve_session_target`、`branch_for_child`（把当前对话抄一份给子 Work）、`dispose`。收下 `work_message` 和 `observation_delivery` 即答复，什么时候写进对话、要不要开始一轮由 Agent 决定。

**向 Host 要东西**（`WorkerHost`）：Dock 工具（`invokeDockTool`、开关）、附件、Main 的模型配置与凭据（`models`）、助手服务（`assistant`，只有助手 Work 有）。Host 没给的那一项不存在，Agent 不能自己绕过去。

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

消息提交的 input kind、实际 delivery 和 custody owner 都由 adapter 确定。调用者的 `auto / prompt / steer / followUp` 原样到达 Worker；普通 prompt 由 Pi input hook 再次检查运行状态后报告实际采用的 `prompt / steer / followUp`，registered extension command 则在 adapter 已解析并取得 invocation custody、但可能长时间运行的 handler 开始前报告。Compaction 期间不能交给 Pi 的普通 input 明确报告 Host custody。这个私有 preflight 是 Worker→Host 的事实通知，不增加逐条批准往返；Host 按 adapter 报告的实际 delivery 提交 receipt 和 Queue 状态；较早的 `isStreaming` 或 extension command 文本不作为 delivery 判断依据。Pi 0.99 会推迟在 extension 仍处理 `agent_settled` 时到达的 input，且不报告 delivery。adapter 在读完附件和图片、即将交给 Pi 的同一时刻判断：此时 Pi 正在收尾，普通 input 报告 Host custody，由 Host 像 compaction 期间一样保管，Pi 发布 `agent_settled` 后再交出；registered extension command 先报告 delivery，再等这个边界后启动；Host Queue 交接同样交还 Host 保管，不在 Worker 里等，否则 Esc 也要跟着等。Pi 0.99 也会让 input hook 接管排队的 input；被接管（handled）的 input 在任何交付路径都报告为 handled，不成为 Pi message 或 Queue item，也不占用下一次 run 的 `operationId`。Pi 0.99 的自动压缩发生在 run 内，abort 用 Pi 自己的 abort 同时结束压缩和这一轮，不只取消压缩。Pi 1.2 起一轮回复从准备阶段（extension 的 `before_agent_start`）就算忙：Pi 报告 `started` 时 `isStreaming` 已为 true，所以 adapter 按 Pi 报告的结果而不是 `isStreaming` 记为直接开始；扩展发起的回复还在准备时到达的普通消息报告为排队，进入这一轮。准备中的 extension 无法被打断，Pi 的 abort 要等它们返回；Pi 自己的 Esc 只记下停止、不等。Dock 照此处理：准备期间的停止记下后立即完成（Worker 状态 `isPreparing` 让 Host 不等这一轮结束），Pi 在这一轮第一次请求模型前截住它；它截住时仍把开始的消息记进会话。停止后、extension 返回前到达的消息若交给 Pi 会并进被停的这一轮而得不到回答，所以 adapter 像 `agent_settled` 收尾时一样报告 Host custody，Pi 发布 `agent_settled` 后再交出。Pi 截住这种回复时最后一条回复是 error（“This operation was aborted”），adapter 以 `agent_settled.aborted` 为准报告为中止。用户自己的消息还在准备时，Host 仍要等它的 delivery 确定，期间到达的下一条消息和停止照旧得到 `admission_pending`。`operationId` 贯穿直接执行和排队执行；只有确实进入 Queue 的消息才创建 `queueItemId`，也只有实际消费 Queue item 时才产生 queue-consumed lifecycle。Queue provenance 与最终 delivery 分开保存：compaction 期间由 Host 保管的 Queue item 可能在 Pi 恢复空闲后以 fresh prompt 启动，但它仍消费原来的真实 Queue identity；普通 direct prompt 则不会产生 queue-consumed。

对话的实时帧、持久 record、分页历史、长正文和图片读取都在 `src/pi/pi-conversation.ts`（`projectAgentSessionEvents`、`PiConversationProjector`、`PiSessionConversation`）。它只把 Pi 的 session entry 和事件当类型用，不加载 Pi agent runtime；`PiAgentAdapter` 和其他把对话存成 Pi 格式会话的 Worker 共用这一份。

Conversation projector 使用同一个实际 delivery 生成 `message.submitted`。已经被 Worker 接受的用户消息始终发布为 canonical conversation frame；Host 的辅助 Queue identity 关联异常时，消息仍须先出现在 conversation。

Conversation 的持久语义也在 adapter 内完成。Pi adapter 把当前 branch entry 投影成 canonical persisted record，显式保留 message、tool result、custom/custom message、bash execution、compaction/branch summary、model/thinking/session/label record 及其 visibility/metadata；Pi 0.99 记录 system prompt 与工具变化的 system message 投影为 metadata，不进入 conversation：`systemPrompt` 列出它设置、移除的段落和新增、移除的工具名（完整名单，不截断），content 按原顺序是说明文字、每个设置的段落原文和每个新增工具定义的 JSON，`systemPrompt.blocks[i]` 说明 content 第 i 块是什么（说明文字、哪个段落、哪个工具），设为空文本的段落只在名单里、没有正文块；usage（如缓存保温费用）和 context edit 没有对应的 Protocol V2 kind，投影为 `source: runtime` 的 metadata `custom` record，分别用 `usage`（类别、tokens、费用、备注）加 `provider/modelId`，以及 `contextEdit: omit | replace` 加 `targetEntryId` 表达；替换内容放在 content 里，按目标记录的方式投影（附件上下文和私有路径照样去掉），工具调用和结果只作为文字给出且遵守文字块的预览上限（超出部分经 content ref 读取），不把这条记录并进那次工具调用的分页单元；系统提示 record 在 history 中不带正文（常常是整份提示和全部工具定义），原文经 content ref 按需读取；这三种 record 在 tree 中都是 metadata 节点，摘要说明改了什么（context edit 摘要沿用目标节点的摘要）；Host 不读取 Pi role 或 Pi session 私有 shape。大型内容的 record 只承载有界 preview，完整内容由 conversation history/content 的 revision、content ref 和 chunk 提供。 默认读取的 `contentComplete` 只说明最终发出的 `content` 是否完整，metadata 的裁剪仍由独立的 omitted fields 表达；二次 preview 和整页字节裁剪后重新确认完整性。原生图片的 descriptor 保留给独立 image 读取路径，但未内联原始 bytes 的 preview 仍为 `contentComplete: false`，保留旧 Client 根据此布尔值调用 `conversation.content` 取得 image data 的语义；文本预算和整页裁剪不隐藏图片身份。Tool result 按原 item 顺序保留图文，只合并相邻 text 为一个 `tool_result`，绝不跨 image 聚合；只有 image 的工具仍保留空的 tool-result 身份块。显式 `view: "references"` 复用同一内容生产器，在原位置输出图片身份而不输出 data；该视图的完整性只比较文字、工具信息和图片引用。Pi 原始 JSONL 和图片读取不变，最近一条正文缓存由两种视图共用，continuation 只增加视图绑定。history 的 `totalBlocks` 与旧 `conversation.content` 的块布局一致，published file 仍在原 tool result 上。Adapter 与 Host 的 history 分页沿用 canonical `toolCallId` 关联完整语义单元，Assistant tool call 与已有的对应 results 必须在同一页。canonical 和二次 preview 的字节/正文预算先保留 tool 身份；args 放不下时裁为带 omitted fields 的身份块，不能删掉 tool call 使 Host 或 Worker 的关联断开。Worker 私有协议还限制整个 conversation history page 的传输字节数；adapter 应先去除可由 content ref 读取的 preview，而不是拆开语义单元。

Conversation 读取位置由 Worker 的当前 Session/branch 管理。只有确认 public SessionManager 的既有持久 entry 对象仍是当前 branch 的完整前缀时，追加才保留同一个 opaque revision 和既有 history/content 位置；同一次 descriptor/content 读取继续返回一致 revision，不改为每条记录的不同版本。旧 history 位置读取其已接受的前缀，不被之后追加的 tool result 改写分页边界。分支替换、Session 更换或 runtime rebind 则轮换读取域并使旧 continuation 失效；不可变记录的 content ref 不变。当前 branch 只长期保留原 entry 引用、ref 与工具身份索引；canonical preview 用单个现有 history page 字节预算的热缓存，另保留最近读取的一条正文视图（原文/图片字符串复用 source，工具多文本聚合与参数 JSON 可能生成新字符串），不按 scan 保存整份会话副本。图片登记事实按原生对象弱引用复用，preview 淘汰不要求重新 hash。当前 branch 同时保留 image ref→原 image 对象身份索引；有界 registry 淘汰后，独立 image 入口及旧 image content 入口从这个权威索引恢复弱登记事实，不复制原图、不重 hash，也不要求先读正文。完整语义页可超过 registry 的 handle 容量，逐图读取仍按需恢复；branch/scope 替换会释放旧索引，不能据此恢复非当前 source。未变 leaf 的正文续读不遍历重投影全 branch，也不重新 hash 所有图片。此行为需要采用修正后的 Worker 源码，不能热修已经运行的旧 Worker；不改变公开 Protocol V2 shape 或旧 image/content 读取能力。

实时事件与持久 record 不需要共享 identity。在线客户端在 `message_update`/tool event 上原位更新组件，完成后直接保留；重建时才从持久 record 重新生成。Adapter 在一个 turn、run、compaction 或独立持久写入形成安全边界后发出私有 `conversation_checkpoint`。Checkpoint 携带该边界的精确权威 branch history snapshot，表示它之前的 conversation frame 都已由这份 snapshot 表达；Host 原子安装 snapshot 并释放 active buffer，不能在稍后读取一个可能已经前进的 history 来猜测边界。Checkpoint 不等待任何客户端确认。

Pi 是当前成熟基底。真实工作需要且 Pi 已经具备的能力，应完整接入 Dock，跨进程适配保留其语义；各客户端按需实现界面，未来 Agent 按各自运行方式接入。

用户 shell 命令（Protocol `bash.run` / `bash.abort`）在 adapter 内走 Pi 自己 TUI/RPC 的同一条路：先发 `user_bash` 让扩展拦截（远程 operations 或整个结果），再 `executeBash(command, undefined, {excludeFromContext, id: operationId, operations})`，中止对应 `abortBash()`。adapter 在开始前发 `bash.started`，把带 `id` 的 `bash_execution_update` 投影成 `bash.output`，结束后发 `bash.completed`；不带 `id` 的执行不是 Dock 发起的，不转发。Pi 空闲时立即追加 `bashExecution` 记录但不发任何事件，所以 adapter 在命令结束后自己补一次 `conversation_checkpoint`；Pi 正在回复时记录被挂起到本轮结束，此间每次 checkpoint 都在 `unpersistedBash` 里列出还在跑或记录未落地的 operationId，Host 据此保留它们的 active frame。会话替换或 Worker 停止时 Pi 自己中止命令并把记录写进旧 session；旧 binding 已失效，它的完成事件不再发布。

Dock 给 Pi Worker 加的命令都以 `dock-` 开头（`/dock-retry`、`/dock-plan`、`/dock-goal`、`/dock-tools`）。两个扩展注册同名命令时，Pi 把两者都改名为 `name:1`、`name:2`，原名不再可用，输入它会当成普通消息发给模型；`/plan` 这类常见名字已有示例扩展在用。

Pi Worker 自带 `/dock-retry`，只在用户主动输入且最近一次模型响应失败、当前空闲时触发。命令使用公开的 extension `sendMessage` 进入 Pi 原有 Session 流程，并等待该轮结束；隐藏的 `alu-dock-retry` 标记保留在 Pi journal 里供识别，但由同一插件的 `context` hook 从模型上下文移除，因此不追加用户聊天指令，也不重放已经完成的工具。它不使用私有 SDK 补丁，不增加自动重试策略；Pi 原有重试、压缩和收尾照常生效。

### Pi 自带的 MCP、codemode 与工具搜索

Pi CLI 以内置 extension 加载 `codemode`、`tool-search` 和 `mcp`，SDK 会话不会自动加载。Worker 用 Pi 公开的 `createCodemodeExtension()`、`createToolSearchExtension()`、`createMcpExtension()`，以同名 `builtin`、`replaceable` inline extension 加入 resource loader（`src/pi/pi-builtin-extensions.ts`）。`mcp.json`、项目信任、`-builtin:<name>` 设置和第三方 MCP extension 的替换因此都按 Pi 原生规则生效；Dock 不投影 MCP 配置，也不另建 MCP 状态或管理接口。

Dock 中 Pi 以 RPC 模式运行：`/mcp` 输出 Pi 的文字状态，`/mcp login|logout|reconnect` 经现有 Extension UI 对话框完成。Pi 终端里的 `/mcp` 管理菜单（启用/停用、暴露方式、浏览工具）只接在 Pi 自己的 TUI 上，Dock 暂不接入，改 `mcp.json` 后 `/reload` 生效。Worker 运行在常无人值守的 Host 机器上，所以 MCP 登录不在 Host 上打开浏览器：授权链接只以通知发给客户端，浏览器不在 Host 机器上时由用户把跳转地址粘贴回输入框。

工具在运行中通过 `ctx.executeTool()` 调用的其他工具（codemode 脚本最常见）只属于调用方：Pi 发出带 `parentToolCallId` 的 nested `tool_execution_*` 事件，并在调用方的 tool result message 上保存有界的 `nestedCalls` 记录。Adapter 不把 nested 事件投影成独立工具；它按 Pi 记录的同一规则（嵌套调用的调用归入同一个模型发起的调用，与 Pi 相同的条数/参数/错误上限，见 `src/core/nested-tool-calls.ts`）在 Worker 内维护实时清单，随调用方的 `tool.output_updated` 重发其最新输出与当前清单，`tool.completed` 携带最终清单；history 直接投影 Pi 保存的记录，`conversation.content` 在完成 tool result block 的 chunk 上再带一次，供 history 页裁掉清单时续读。参数取自 Pi 事件里的原始值、按 Pi 的字节上限整份保留或省略，不经过 Dock 面向模型调用参数的 JSON 投影上限，所以实时与重开逐字一致。Dock 不读取 codemode 结果 `details` 里的私有格式。

项目状态的资源正文通过 `resource.content.v1` 读取。Pi adapter 为已加载的 Skill、Prompt、Project Context 及文件来源的 SYSTEM.md / APPEND_SYSTEM.md 生成 opaque `contentRef`；只有这些当前登记的资源可以读取，不接收客户端任意路径。Worker 经私有 `resolve_file_source` 将已登记资源的路径交给 Host，不读取或传输正文。Host 从磁盘当前 UTF-8 文件按字节续读，复用 source-file 检查，文件变化时要求重新打开，不保存正文快照、不执行资源或触发 Reload。全局文件不受 workspace 根目录限制；Project Context 中的 system 文件项只对应实际磁盘文件，Pi 内置生成提示不作为文件资源列出。

命令发现按能力而不是具体名称接入。Pi adapter 从公开的 loaded prompt template 保留 `argumentHint` 和可检查正文；正文分页来自内存中的 `PromptTemplate.content`，不让 Host 或客户端读取 `filePath`。Extension command 的动态参数候选由注册时的 `getArgumentCompletions` 产生，并通过同一通用结果体返回；Dock 自带 Extension command 也沿这条 owner API 声明候选，不在 Host 建名称表。Catalog 后续读取使用 `{name,source}`，按名称和来源共同确定目标。

Host 显示空闲时也把中止交给 Worker：扩展发起、仍在准备的请求只有 Worker 能取消。运行中打开的扩展编辑器带着本轮的取消信号，随中止关闭。Pi 的 abort 会等待 Agent 回到 idle；普通 `command.abort` 不动 Queue，已排队输入可以在当前输出终止后合法启动下一轮，因此 abort 的完成时间不是 Worker 存活探针。Host 不因 abort 尚未返回而切断 Worker。像 Pi TUI 按 Esc 一样“中止并把排队文本放回输入框”由 `command.abort_restore_queue` 一步完成：Pi adapter 在同一次 Worker 调用中先清空 Pi Queue、紧接着 abort，中间不给 Agent 取下一条的机会；Host 在同一个 interrupt 期间暂停把压缩期间暂存的消息交给 Agent（已开始的那一次交付先完成），停下后把 Host 暂存和 Pi 清出的消息按原顺序返回给调用者，并以 `queue.cleared(reason: abort)` 通知其他入口。已经被 Agent 取走的消息留在对话里，只在回执的 `inFlight` 中列出，不阻止中止。客户端不再先取回再中止。Compaction 只是运行中的暂停边界：completed 后 Pi 自己的 retry、extension/guard continuation 仍按原生顺序继续，Host-deferred Queue 在第一个合法时机自动交付，不能抢断 continuation，也不依赖任何客户端在线。

### Agent-facing Host capability pattern

Agent 通过 observation 已建立的 reverse-capability 形状访问 Host-owned 事实。该边界使用按能力定义的接口，不提供 Worker 直连、Host object proxy 或通用任意 RPC：

1. `src/core/` 定义一项 capability-specific HostPort 与 Dock 已有 DTO；
2. Registry 在创建/reopen Worker 时注入 HostPort；
3. `AgentWorkerConnection` 只从已认证连接上下文取得 `sourceInstanceId`，并继续使用 host epoch、runtime generation、worker incarnation 和 ordered private envelope fencing；Worker request 不能自行声明 caller identity；
4. Worker bootstrap 只在 Host 授予对应 `dock.*` capability 时建立一个小型 bridge；
5. Agent adapter 用 inline extension/tool 或其他 runtime-native API 暴露能力；使用说明可随包提供为 Skill 或按需阅读的工具手册。

每项能力保留自己的 closed request/result、bounds 和开关规则。公开业务 DTO 统一在 Protocol V2 定义一次；private envelope 只验证 source binding、路径等 Host-private fact 和跨进程边界。

Host 读不懂 Worker 的一次 call 时会结束这个 Worker。所以 Worker 的 `OrderedWorkerSender` 发出每个 `dock.*`/`ui.*` call 之前，对序列化后的那份内容（正是 Host 收到的样子）先用 Host 同一个 `validateUiCapabilityArgs` 检查，不合格就让这次调用在 Worker 里失败：模型把 Dock tool 参数填错，得到的是 tool error；扩展的 UI 调用填错，得到的是被拒绝的 Promise。Host 一侧的检查不放宽。

`dock.attachments` 是这个 pattern 的第二个实现，而且始终随 managed Worker 提供。`command.submit` 的 full attachment metadata 通过 private invoke context 与公开 file IDs 做逐项一致性检查；Pi adapter 把一个明确的 untrusted metadata block 放进原生 prompt，同时在 live/history projection 中恢复干净文本和 `AttachmentDto[]`。该内部 block 由 Worker 使用 agent state 中持久、`0600` 的随机 key 做 HMAC 认证；普通 prompt 即使复制相同文本形状也不能伪造 attachment provenance，认证失败的文本不会被静默剥离。Host path 不进入 invoke context、Queue 或 conversation。

Pi inline extension 提供 `dock_attachment_list` 和 `dock_attachment_resolve`。list 只返回 path-free metadata；resolve 通过当前 authenticated Worker 的 reverse call 让 Host 检查文件后，把一个 absolute path 只交给 Agent tool result。外部 conversation projector 对 resolve tool text 做固定 redaction，structured details 也不含 path。Bundled `dock-attachments` Skill 指导 Agent 在修改、转换或解压前，把原文件复制到 workspace 或临时目录并保留永久原件；文件名、media type 和内容一律是不可信数据。普通 resolve 只返回工具所需的文件路径，不调用 Pi image loader；文件访问权限以 Host/Worker 所用的同一 UID 为边界。

当 `command.submit` 的 authenticated attachment context 含 `image/*` metadata 时，Pi adapter 在真正 delivery 前经同一个 attachment reverse capability resolve 每个图片 fileId，把 private Host path 只转换为本轮 Pi 原生 image input，同时继续把完整 attachment metadata 放进已认证的 prompt context。显式 image 与 attachment-derived image 共用 Pi 已有的数量、单图和 aggregate bytes 检查；Dock 不维护 model/provider 视觉能力表。SDK 事件转换仅在 Worker 内保留后续匹配所需的 SHA-256，先认证附件上下文再裁剪用户文本，不在公开 image block 增加 hash、bytes 或 path 字段。附件上下文按起止标记定位后抠除，不要求它位于文本末尾：Pi 会在 Dock 交出的文本之后追加自己的说明（如图片缩放提示），live projector 把「Dock 交出的文本 + 空行 + 追加说明」仍视为同一次 submit（#360）。Pi user message 中图片 bytes 的 SHA-256 与已认证 `AttachmentDto.sha256 + mediaType` 相同时，live/history projector 给 image block 加上对应 `fileId`；它不删除 image block 或 attachment，也不把 Host path 放进 Worker result、Queue 或 conversation。

Dock 通过 Pi resource `extensionsOverride` 明确持有 canonical inline `show_image`，只移除其他 extension 注册的同名 tool，不依赖修改用户的 `~/.pi`。tool 只把 `{path}` 登记到 Worker-local generation/session registry，Pi session 不持久化图片 bytes；live 与 history projector 从 structured details 产出同一个 path-free `PublishedFileDto`。`file.read` 由 Host 通过私有 `resolve_file_source` 向当前 generation 的 Worker 解析登记引用，取得发布时冻结的文件身份后直接读取；Worker 不返回文件字节。来源解析和整个读取共同受 Host 的查询、会话替换和停止检查保护；公开分页形状不变，Host 不另存登记或文件副本。原生 Pi ImageContent 在 live 与 history image block 上发布同一个由 immutable decoded bytes SHA-256 决定的 content ref；同 bytes 在 append、refresh 和 Worker restart 后保持 identity。既有 image block 与 `conversation.content` 形状保持不变，避免破坏已发布的 Protocol V2 客户端；新客户端通过单连接 `conversation.image` stream 的 ready frame 获得 canonical lowercase SHA-256 与 decoded size，再以 callback 读取 bytes。这里没有 provider context hook。

Pi Worker 内建 `/dock-tools on|off|status`。开关按来源 instance 持久化，新建和 adopt 默认开启。原生协作升级对没有 `collaborationVersion: 1` 的旧 catalog record 做一次迁移，旧值缺省、true 或 false 均改为开启；旧格式无法区分默认 false 与旧的明确关闭，故两者都按新版产品约定迁移。新 record 与迁移后的 record 写入仅 catalog 使用的版本标记；升级后显式 `/dock-tools off` 会跨重启和 reopen 保留，非法版本标记按损坏数据拒绝。迁移不扩大项目授权，不改变 OS 安全、project trust 或工具许可上限。子 Work 的精确 `allowedTools` 在 Pi 工具 registry 执行处限制能力，开关不能扩大这个上限。`dock.tools.configure` reverse capability 始终存在，Host 在开关为 on 时授予 `dock.tools`。开关通过 Pi 原生 `setActiveTools` 更新可用工具及其提示，off 时这些工具离开 active set。Pi 1.3 起重开 Work 或切回已有会话时，恢复该会话上次请求所用的工具；Dock tools 仍以开关为准，会话里记录的不算数。使用手册随包保存在 `docs/agent/dock-tools.md`，由各工具的 description 提供实际文件路径，Agent 需要时读取；它不注册为 Pi Skill。切换开关不执行 resource reload，正在进行的调用继续使用有效上下文。用户主动 reload/rebind 时，开关仍从 Worker-level capability state 恢复。

子 Work 只注册不带 target 的 `dock_send({message,done})`，消息只到父 Work。顶层 Work 开关开启时提供：`dock_spawn`、`dock_models`、`dock_interrupt`、`dock_stop`，以及 `dock_list({scope?: "live" | "all"})`、`dock_machines()`、target 必填的 `dock_inspect`、`dock_watch`、`dock_cancel_watch`、`dock_deliver_file({path})`、`dock_system({cwd,machine?,id?,cursor?,offset?,revision?})`、`dock_create({cwd,name?,machine?,systemId?,saveDefault?,model?})` 和 `dock_send({target,message})`。list 只读短状态，不拉取 conversation；inspect 才按需读取一个按消息条数分页的 conversation page。Agent-facing client 把 canonical message page 渲染成 `target_user / target_assistant / target_other` 引用流，保留消息角色与来源，不插入反复的防御性指令；结构化 DTO 只留在 tool details，不把 JSON、TUI reconnect event、thinking、tool call/result 或 Host metadata dump 放进模型上下文。`limit` 只限制一次返回的消息条数，选中的消息正文保持完整；若底层传输无法承载则明确失败，禁止返回截断内容。默认读取最近一条，Agent 只有在主人需要更早内容时才使用 continuation cursor。

`dock_deliver_file` 只接受 absolute path。Host 从 authenticated Worker connection 取得 source instance，把 readable regular source 的 path 与 identity metadata 暂存在当前 `ManagedInstance`；它不在 registration 时读全文、hash、复制或持久化。最多 100 MiB（含边界），跨 Pi session replacement 保留，stop/Host restart 后消失；已有登记不因 `/dock-tools off` 删除。公开 list/download 只含 path-free `DeliverableDto`，bytes 由 Host 专用 stream 直接送给客户端并用 terminal SHA-256 核对，始终不经过 Worker。`show_image` 继续使用独立的 Worker session-scoped inline image 语义。

`dock_machines` 沿 Main 的同一 Machine authority 返回名称、availability、platform、Home 与 workspace roots，Agent-facing 文本省略内部 `hostId`。`dock_create` 接受 absolute cwd、可选名称和可选的精确 Machine display name；省略 Machine 时创建在来源 work 所属 Machine，提供时由 Main 将唯一名称解析为 `hostId`，再沿 Host 的 canonical `instance.create(hostId)` application service 创建。找不到、重名或离线都明确失败，不让 Agent 输入或看到 Machine UUID；新 instance 默认开启 Dock tools。顶层 Work 之间的 `dock_send` 在正文前加一行 `[Agent message from "名称"]` 来源标题，再沿同一个 `command.submit` application service 默认使用 `delivery: auto`（主人 2026-11-13 指出真实消息迟到后改定）：空闲立即开始、忙时下一步接入；只有显式 `followUp` 才等当前轮结束。因此目标的运行中/空闲判定、Queue、receipt、持久 conversation 与普通 user message 完全一致。`dock_spawn` 交出的第一份任务仍显式用 `followUp` 提交（子 Work 的会话还没开始，直接开始一轮）。父子 Work 之间的消息不走这条路，见下文「父子 Work 之间的消息」。正文逐字保留，来源使用人类名称并省略 UUID。Dock tools 提供显式 interrupt/stop，但不代答 interaction 或提供任意 Agent 私有控制。

watch tool 只登记 Host subscription 并立即返回。Host completion 通过私有 `observation_delivery` control 到达当前 Worker；completion 含 target/reason/time，目标正常结束一轮时还带它最后一条回复，不携带其余 conversation。adapter 把它做成可见的 `dock-tools-watch` custom message，放进与父子 Work 消息同一个收件箱（见下文「父子 Work 之间的消息」的送达时机）：Agent 正在工作时在它的下一步写入，空闲时写入并开始一轮，主人 Stop 后不自己开始，「取回 Queue」和 reload 都不丢；不再用 Pi 的 steer 队列。排到整轮之后会让通知在 Agent 早已另作处理后才到；回复过长或需要更多上下文时 Agent 再 inspect。watch completion 不走用户消息的 `command.submit`。cancel/off 等 Host 确认期间收件箱暂不写入会话，确认后把被取消 watch 还没写入的通知从收件箱拿掉、之后到的也丢弃，失败则照常写入；同一 watch ID 至多写入一次。Dock tools 手册说明按需读取、等待、创建和消息来源边界，入口随启用的工具描述提供。

### 父子 Work 之间的消息

父子 Work 用 `dock_send` 互发消息（card #666）。消息作为扩展消息写进对方会话，不是 user message，不进 Queue，也不借用 `command.submit`：

- **Host**：父子总在同一台机器上，由运行它们的 Host 答复两者之间的一切：子 Work 的请求，以及父 Work 对自己子 Work 的 `send`/`interrupt`/`stop`。Main 与 SubHost 的 Dock tools port 先问本机 Registry `answersLocally`，答是就交给本机，不经 Main，所以 Main 离线或版本较旧时也照常收发。SubHost 上的子 Work 经 Main 创建，Main 给了它另一个 ID；SubHost 在 spawn 结果经过时按创建 operation 记下这个 ID，父 Work 用哪种 ID 都能找到它，发给父 Work 的消息与结果也用它。`src/control/work-messages.ts` 用私有 `work_message` control 把结构化 `WorkMessage`（来源、正文、`done`，或子 Work 停下的通知）交给对方 Worker，按接收方排队，同一对父子按发出顺序送达；Worker 收下即确认。
- **欠结果**：只记在 Host 的 `WorkMessages` 里，只用来判断 Host 自己看到的停止和崩溃要不要告诉父 Work。子 Work 创建起欠父 Work 结果；父 Work 每发一条消息、子 Work 每次没汇报就停下都又欠；子 Work 的 `done: true` 消息送达后不欠；父 Work 自己 interrupt 或 stop 它时也不欠。
- **送达时机**（`DockToolsBridge`）：Worker 收到的消息（以及 `dock_watch` 的通知）先放进 bridge 的 inbox，它跨 reload 存活。不用 Pi 的 steering/followUp 队列，因为「取回 Queue」调用的 `clearQueue()` 会把排着的扩展消息一起清掉。Agent 空闲时，用 `sendMessage(..., { triggerTurn: false })` 立即把全部消息写进会话，再用隐藏的 `dock-work-wake` 标记开始一轮（`context` hook 把它从模型上下文去掉），写入先于开始，开始失败也不丢；忙时在下一个 `turn_end` 或 `agent_before_settle` 边界把它们交给 Pi（同样 `triggerTurn: false`，Pi 在这一步结束后写入），并要求再发一次请求，所以 Agent 在停下前答复它们。「写进了、还没答复」在交给 Pi 的那一刻记下，到下一条回复开始为止：Pi 只把它运行中的消息告诉扩展，它替扩展写入的消息不发扩展事件。`agent_settled`、压缩结束和重新 attach 后再投递剩下的。主人中止的一轮（`agent_settled` 的 `aborted`）之后不自己再跑，和主人的插话一致（adapter 的 abort 保证中止后没有自动续跑）：已经写进会话没答复的、当时还在 inbox 里的消息都不开始新的一轮，inbox 里的照样写进会话；之后新到的消息、或别的原因开始的一轮结束这种状态。写入的是 customType `dock-work-message` 的扩展消息，首行是来源行（`[来自子 Work「X」]`、`[来自子 Work「X」· 已完成]`、`[来自父 Work「Y」]`、`[子 Work「X」异常停止]`），details 是 `{from, done?, stopped?}`；模型把扩展消息当用户位置的内容读，靠首行区分来源。
- **异常停止**：子 Work 的 Worker 在一轮结束（`agent_settled`）时检查：这一轮带着父 Work 的工作（第一份任务，或期间写入的父 Work 消息），而最后一次顶层工具调用不是成功的 `dock_send`（同一步里已经成功发出 `done: true` 的，和它一起结束的其他调用不算：Pi 只有整批调用都要求结束才结束这一轮），就发私有 `unreported_stop`（原因、最后的话）。Host 收到就告诉仍在运行的父 Work，并重新记成欠结果，不再以 Host 的欠结果为准：父 Work 的新消息和子 Work 对旧活的 `done: true` 可能在同一步交错，只有 Worker 知道这一轮还欠什么。唯一例外是父 Work 自己 interrupt 了这个子 Work：它之后发来的「被中断」报告不转告，直到父 Work 再发消息给它。主人自己开始、期间没有父 Work 消息的一轮不算；子 Work 的第一份任务之后，交给它的 prompt 都是主人的。子 Work 被停止或崩溃由 Host 在它的生命周期变化时判断，最后的话取 Host 自己保存的会话副本；父 Work 自己停下时不通知。不提醒子 Work 补汇报，Host 重启后也不补通知（子 Work 不恢复）。
- **dock_wait**：只在 Worker 内等待，不经过 Host。`src/worker/child-messages.ts` 记下本 Work 交过工作、还欠结果的子 Work；等待期间到达的子 Work 消息（包括这一步里已到、还没写入的）作为工具结果返回，不再另外写入。不是最终结果的消息可能是问题，立即结束等待；`all` 等每个子 Work 都给出结果或停下，`target` 等它的结果。有用户消息排队、用户取消或超时即返回，所以等待不会把用户挡在外面。结果比派活结果先到的子 Work 不记入。它用于本轮不能结束的场合：Dock Goal 在一轮结束时立即开始下一轮，靠结束本轮来等子 Work 会白白耗掉轮数。`dock_cancel_watch` 和关闭 Dock tools 都不影响父子消息。

`dock_models` 的事实由 Worker 读：Host 只返回 Main 的 `child-models.json` 里用户列出的模型（只有 `provider`/`id`，不带用途说明；SubHost 上的 Work 由本机 Host 回答，名单向 Main 取），Worker 用当前 Pi 的模型和可用模型补上 thinking level（pi-ai `getSupportedThinkingLevels`）、上下文长度和是否能看图，父 Work 自己的模型总排第一。名单只影响 Agent 看到什么，`dock_spawn` 仍接受任何可用模型。

`dock_spawn(withContext:true)` 让子 Work 从父 Work 当前对话的副本开始。请求里只有这个开关，没有会话路径：Host 用私有 `branch_for_child` control 让父 Work 自己的 Worker 用 Pi `createBranchedSession` 把当前分支写成子 Work 目录下的新会话文件（Pi 在文件头记下来源会话），再以这个文件创建子 Work。分叉点在仍有工具调用未返回的那条回复之前，子 Work 不会看到“创建自己”的调用以无结果结束。子 Work 仍用父 Work 为它选的模型。Pi 只为新会话记录模型和 thinking level，所以 adapter 在子 Work 启动后补记一次，reload 时恢复的是子 Work 自己的设置。

## Extension UI

Pi Worker 自动加载 `alu-dock-plan-goal`。`/dock-plan` 只读调查并提交完整计划，由用户在编辑器审阅修改后选择执行或继续讨论；`/dock-goal` 用轮数预算自动推进，`agent_before_settle` 是唯一次轮入口。业务状态只存在 Pi 当前分支 custom entries，恢复后暂停。模型工具按模式启用：规划时补上内置读取工具，并由 `plan_submit` 的 `prepareLoadout` 把非只读工具从请求中隐藏，不改动用户的工具开关；结束规划时只收回自己补上的读取工具，用户在规划期间设置过工具（adapter 经 `PlanGoalPort.toolsChosen` 告知）则保留其选择，不再收回；codemode 在 `only` 模式下会隐藏其余所有直接工具，所以 Dock 内置的 codemode 规划期间改用 `on` 模式（经 `PlanGoalPort.isPlanning` 读取），不改它的开关和用户设置；调用时再按只读声明拦截（含嵌套调用）；第三方工具的 `readOnlyHint` 需要可信，这不是系统沙箱。计划正文只在变化时保存。薄启动回调处理 Pi 扩展消息在开始前失败/被接管及准备期间取消（准备期间被取消的请求在即将开始时由 adapter 交给 Pi 的 abort 截住，不调用模型；Pi 仍记下这条 Goal 提示，扩展把它的时间记在状态里，并用 `context` hook 让它不进入之后的普通请求；压缩仍会带上它，见[已知技术债](../technical-debt.md#准备阶段被停掉的-goal-提示仍会进入压缩摘要)。停止后、旧准备结束前交的新 Goal 等旧准备结束后启动，不随它一起暂停）；运行中 abort 与 settled 由 Pi 负责。Host 不增加目标状态、预算或协议。见[使用说明](../agent/plan-goal.md)。

Extension component 和 Promise 留在 Worker。Worker 负责 component render、input、invalidate 与完成回调；Host 负责 generation、问题的开放与第一个回答、事件路由；TUI 或 WebUI 负责各自支持的显示与输入。问题属于 Work：没有任何客户端在场时也开放，要求共享问题的 read/follow 都收到它，任何客户端都可回答，以第一个回答为准。旧客户端的操作连接保留；新的操作连接替换旧连接，但不会取消 Worker 中等待的 interaction。见 [control.md](control.md#readfollow-与-extension-ui-操作)。

会话替换的 UI 交接由同一生命周期控制：Worker 暂存新插件初始化期间的单向 UI 更新，在发布 `dock_session_replaced` 后按顺序释放；Host 在收到替换事件时立即使旧 UI 失效，不等持久化转换队列才清理。这样新状态不会被后续收尾清空。取消替换不进入交接，失败则丢弃暂存发布；同一 session 的插件 `ctx.reload()` 在原有重置完成后释放新状态。暂存范围仅包含新插件发布的 UI 更新；Work 的 Dock tools 授权保持独立，不参与迁移。

某个客户端尚未支持的 Extension UI，只在该客户端不可用；extension runtime、Agent 和其他客户端继续运行。客户端不得代替用户生成回答。

Extension command 仍通过完整 Agent input 语义执行，不另建第二条命令通道。Worker 在执行前确认当前输入确实命中已注册的 Extension command，并只在该 handler 尚未结束时，把同一次提交已有的 `operationId` 附到 `extension.notification`。它只表达来源关联：通知仍不是 conversation record。handler 返回后遗留的 timer、后台任务以及其他被动 Extension 通知不携带该 ID；Host 不按文本、时间或命令名称猜测来源。

## 新增 Agent 或能力

新增使用现有 Dock 能力的 Agent时，只增加 Worker adapter 和 runtime kind 注册，不修改 Pi adapter和不相关客户端：照[一个 Worker 要回答什么](#一个-worker-要回答什么)实现 `WorkerAgent`，用 `runAgentWorker` 做入口、`createWorkerInstance` 做 Host 侧创建。

Agent 出现新的真实能力时，在 Protocol V2 定义一次，由提供该能力的 Worker adapter 产生，再由需要它的客户端实现。Host 只有在这项能力确实增加新的控制或生命周期规则时才需要变化。

## Pi SDK 升级

频繁的 Pi 版本升级使用独立的[兼容性准入门](../pi-sdk-upgrades.md)，不混入普通测试套件。入口是 `npm run test:sdk-upgrade`，场景实现在 `test/pi-sdk-compat/`；它经过真实 Dock/Worker/Pi public SDK 边界，但只连接本机确定性 transport，不访问外部模型。

## 代码范围

- `src/worker/`：各种 Agent 共用的 Worker 两头：私有通信（`worker-protocol.ts`）、进程监管（`worker-process.ts`）、Host 侧连接与创建（`agent-worker-connection.ts`、`create-worker-instance.ts`）、Worker 侧外壳（`worker-shell.ts`），顶层 Work 给模型的 Dock 工具的名称、说明、参数和每次调用向 Host 问什么（`dock-tool-definitions.ts`，Pi 扩展从这里注册），以及把 Dock 工具结果写成给模型看的文字（`dock-tools-client.ts`、`child-messages.ts`）。不依赖 Pi。
- `src/pi/`：Pi Worker 的入口、Pi adapter 与 Dock capability extensions。`pi-conversation.ts` 是 Pi 格式会话交给 Host 的对话，不依赖 Pi agent runtime。
- `src/assistant-agent/`：个人助手自己的 Agent 和它的 Worker 入口；`src/assistant/` 是 Main 上保管她的人设和记忆的服务。
- `skills/dock-attachments/`、`docs/agent/dock-tools.md`：随包发布的附件 Skill 与 Dock tools 使用手册。
- `src/control/`：Host control、Worker supervision 与 session routing。
- `src/core/`：Dock 自己的协议数据与跨实现概念，不依赖 Pi runtime。
- `src/tui/`：本机终端客户端（通常经 SSH 使用），不持有 Agent runtime。

具体实现按以上边界组织。出现跨层重复定义或投影时，先将能力收敛到所属层，并复用 Protocol V2 的同一定义。

`dock_system` 通过同一 Protocol 查询目录候选或分页读取原文件；返回正文以引用块呈现。`dock_create` 显式选择覆盖目录默认；未选择时交给创建 Host 应用目录默认，未配置才用 Pi 原生行为，已配置但损坏则明确报错，不创建首项。`saveDefault` 是独立明确保存，必须提供显式 ID。`model` 是新 Work 的起始模型，与 system 选择并入同一份 workerConfig，由目标 Worker 按上文规则解析；不开放 generic workerConfig。来源绑定仍由 Host 验证，新 Work 默认开启协作。

### 原生子 Work

子 Work 没指定 thinking level 时沿用父 Work 当前那一档，换了模型也一样；模型没有这一档时由 Pi 取最接近的一档（`clampThinkingLevel`，与 Work 换模型时相同），父 Work 的 Worker 在 `dock_spawn` 结果里写明实际档位。

`dock_spawn` 复用正常 instance.create 和第一份任务的 `command.submit`，父子关系 `parentId` 持久化到 catalog 并经 Protocol V2 投影，不另造调度器。先创建再提交任务；提交结果不确定时保留可见子 Work，不自动重放。只有沿用父 Work 模型时才沿用它的 thinking；父 Work 明确要求子模型不支持的 thinking 时，Worker 启动失败，不留下空的子 Work。子 Work 用 `dock_send` 的 `done: true` 把结果发给父 Work（见上文「父子 Work 之间的消息」），Dock 不再替父 Work 登记等回复的 watch。父 Work 停止或崩溃时子 Work 一并停止；崩溃的子 Work 只能 Stop 收走，不能 Continue。

Worker init 的 `child` 与 `allowedTools` 是 Host 给出的强类型字段，不放在 adapter 私有的 workerConfig 里。`allowedTools` 是精确工具名上限，Pi registry 负责执行（包含 nested/deferred/MCP），子 Work 总能用 `dock_send` 联系父 Work；它不是 OS sandbox，授予 `bash` 即授予完整 shell。旧的 `subagent` 扩展照常加载。子 Work 的系统提示附一段固定指引：父子同时工作，父 Work 只看得到 `dock_send` 发出的内容；干活中用 `done: false` 告诉父 Work 它现在该知道或回答的事（影响它工作的发现、问题、需要商量的点），不发确认或空进度；做完用 `done: true` 发结果。消息正文不改写，只加 Host 确定的来源。详见 [协作手册](../agent/dock-tools.md)。
