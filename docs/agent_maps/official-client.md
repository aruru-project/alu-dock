# 官方 Desktop / Android Client

## 先确定改的是哪件事

官方客户端是 Alu Dock 的第一方入口，不持有 Agent runtime。产品依据是 [STORY](../../STORY.md) 和 [客户端设计理念](../client-design-principles.md)；开发约定见 [official AGENTS](../../clients/official/AGENTS.md)，会话接纳、回放和界面分工的细节见 [Conversation ownership](../../clients/official/CONVERSATION_ARCHITECTURE.md)。本文按用户动作定位实际所有者，不是另一份实施计划。

```text
App / 区域组件 → 按领域划分的 Pinia store → typed bridge
                                      │ 本地 IPC
                              Tauri 平台装配与文件交付
                                      │
                           Rust core 的事实与协议实现
                                      │ Protocol V2
                            Host → 私有 Worker transport
```

- Host/Worker 提供工作、Session、内容和操作的远端事实。Rust core 保留已经接纳的事实、读取任务和本次原生运行的文件；Tauri 负责连接生命周期、IPC 和 OS 能力，不再实现一套协议或业务恢复器。
- Vue 拥有可销毁的显示投影、编辑和显示意图；断连不能清空已有内容、卸载编辑器或抢焦点。远端状态只限制依赖它的相应操作。
- 当前实现使用同一套 Vue/Tauri/Rust core；Desktop 与 Android 只在平台边界分支。官方客户端不访问 Worker 私有存储，自定义客户端也不走这里的本地 IPC。

以下路径除特别注明外，相对 `clients/official/`。

## 改动入口与事实归属

| 要改什么 | 谁持有事实/状态 | 用户入口与关联文件 | 最接近的验证入口 |
| --- | --- | --- | --- |
| 连接、配对、地址、切 Host、目录刷新 | core `host_registry.rs` / `connection_router.rs` / `pairing.rs`；Tauri `ConnectionRuntimeState`；Vue store 只保最后接纳的目录与本地选择 | `stores/host.ts`、`stores/app.ts`、`ConnectionLanding.vue`、“连接与配对”（`HostSettingsPanel.vue`）；`bridge.ts` → Tauri `connection.rs` / `connection_state.rs` → core | core 连接/registry 测试；App native-boundary 门；真实配对/切网须设备检查 |
| 新建 Work：机器、模型、目录、system | Host 的 `instance.create` 与 `workerConfig`（[control.md](control.md#protocol-v2)）；机器模型列表来自 `model.visibility.get`，客户端 `stores/model-catalog.ts` 按连接 + 机器缓存、不设有效期（读一次要在那台机器拉起一个 Pi），模型行旁的刷新按钮重读；目录列表来自 `workspace.list`（任意绝对路径）；system 候选与目录默认来自 Host 的 system API。客户端只保对话框内的选择 | `NewWorkDialog.vue`：第一屏「创建位置」「模型」（默认「Pi 默认」，选了才并入 `workerConfig.model`；旧 Host 没有模型列表就不显示这一行）、最近创建、选目录、恢复 Session；选目录用 `DirectoryBrowser.vue` 的 `picker` 模式——桌面和手机都一次只看一层、面包屑返回，筛选框只筛当前层、进入即清空，输入绝对路径 / `~` / 相对路径后回车直接前往（`lib/machines.ts` 的 `typedDirectoryTarget`）；没有保存默认时 system 列表预选第一个可用候选，确认即创建；Work 里看文件的树状模式不受影响 | `newWorkSystem.test.mjs`（system 预选、模型并入创建、旧 Host 无模型行、重开用缓存、刷新重读）、`directoryBrowser.test.mjs`（单层筛选、进入清空、路径前往、错误原地提示）、`machines.test.ts`（路径解析）；根目录 `pi-create-model-real.test.ts` 走真 Worker 验证起始模型 |
| Host 设置：按机器隐藏模型 | 各机器 Host 的 `model-visibility.json`（[control.md](control.md#模型隐藏列表modelvisibilityv1)）；core `model_visibility.rs`；Vue 页面持有未提交草稿，`stores/surfaces.ts` 只确认离开时会丢失的编辑；`stores/model-visibility.ts` 按连接/机器持有已提交保存及失败或未知后的草稿，关闭/Esc/返回/切机器不取消保存。设置页每次打开都重新读 Host（它靠这次读确认结果未知的保存），读到的列表和保存成功的隐藏列表都写进 `stores/model-catalog.ts` 的共享缓存，新建 Work 的模型选择读的是同一份。`MachineSettingsResults.vue` 在设置页关闭后继续反馈原机器的结果；已在当前设置页展示的成功不重复提示。未知提交之后的新读取若确认有效列表与提交一致，收起该提醒并说明当前设置一致，不把旧请求改判为成功 | 侧栏“Host 设置”或模型选择里的“管理隐藏的模型”→ `work-actions.openMachineSettings` → `MachineSettings.vue`（`lib/modelVisibility.ts`）；Tauri `work.rs` 的 `model_visibility` / `set_model_visibility`。保存是整份替换，结果未知时可直接再存，不进 Work 操作结果 | `tests/appInteraction.test.mjs` 的真实 App/`PageDialogs` 入口；core `model_visibility::tests`；Host 侧 `model-visibility-real.test.ts` |
| 每次请求怎么到达 Host（链路、心跳、断链重连） | core `connection_router.rs` 持有每个 Host 一条链路，`link.rs` 把每个请求变成链路上的一条流（[Protocol V2](control.md#protocol-v2)「一条连接多条流」）；调用方（unary、follow、control、图片、文件）不区分链路和裸连接 | 无界面入口；链路掉了时 follow 显示「连接已中断」并自动重试（重试期间不重复写状态），下一次操作重新选址。选址时已验证地址按偏好顺序依次起跑，各领先 `ROUTE_RACE_STAGGER`、前一个失败立即起跑下一个，先完成 hello 者胜，其余关闭；刚失败的地址排最后，Android 网络变化清空失败记录。顺序与地址类型（局域网 / VPN / 广域网）由 core `ConnectionKind::of` 按地址判断，用户不选类型、策略或顺序；档案按尝试顺序保存。设置页经 `watch_host_route` 在 Host 详情里显示当前正在使用的地址，Host 列表每行只写地址数 | core `link::tests`（一条连接、断链重连、静默链路超时）、`connection_router::tests`（静默地址不拖慢、全失败汇总）、`connections::tests`（地址类型判断、旧档案按地址重排）；`appInteraction` 设置页显示正在使用的地址、Host 列表不挂具体地址；根目录 `test:client-protocol` 走真实 Host 链路；手机切 Work/Stop 耗时须真机 |
| 进入 Work、断连续读、前后台恢复 | core `observation.rs` 续读；`SessionContent` 接纳内容与身份；Vue `stores/observation.ts` 订阅和确认（含窗口焦点与暂离），不拥有另一份会话 | `start_conversation_follow` / `read_conversation_content` / ACK；`conversationSession.ts` → `conversationContent.ts` → `ConversationView.vue` | `contentProtocol.test.mjs`、core observation/content 测试；仅改局部时不要重复整条门 |
| 历史、正文、记录错误和重试 | `session_content_reader.rs` 的分页/任务；`session_records.rs` 的不可变内存正文；`session_content/binding.rs` 的有界显示回放 | `ConversationRegion.vue` 的加载更早/重试/可见条目；不直接调用远端正文分页 | content 门、冷打开/回放测试；App 局部接线 |
| 系统提示变化、对话之外的费用、模型上下文改动 | 历史投影器（`lib/conversation.ts` 的 `projectRuntimeRecord`）按 record 的 `systemPrompt` / `usage` / `contextEdit` 产出一行提示或可展开的记录面板；系统提示面板先列全部改动的段落和工具（不截断），再逐段按原文显示并按 `systemPrompt.blocks` 标明每段是什么（带 `label` 的 `plain` 条目）。整份提示和替换内容标记为 `readOnOpen`：`ConversationView.vue` 只在面板展开后才把它登记进读取兴趣，折叠时无论离可视区多近都不读；面板内显示读取中和失败重试（core 的 `entry_state`） | `ConversationRow.vue` 的记录面板（`<details>` toggle）、`ConversationProcessPart.vue` | `conversationPresentation.test.ts`（投影）；`recordPanelReading.test.mjs` 挂载真实 `ConversationView`，验证折叠不读、展开才读、关闭撤回、读取中与失败重试；core `conversation::tests` 保证这些字段送到界面 |
| 对话按轮显示：摘要行、展开 / 收起过程、运行中计时 | 两个投影器（`lib/conversation.ts`）在扁平 item 上产出 `turn` item 和 `turnId`；`lib/conversationPresentation.ts` 的 `conversationSections` 是纯函数分组；展开状态只在 `ConversationView.vue` 内 | `ConversationTurnSummary.vue`；点摘要行经 store `holdReadingPosition` 保住阅读位置；边界规则见 [Conversation ownership](../../clients/official/CONVERSATION_ARCHITECTURE.md#turns) | `conversationPresentation.test.ts`、`paritySlice1.test.ts`；`appInteraction.test.mjs` 覆盖读取恢复时的运行中轮；展开 / 收起不跳位须真实浏览器 |
| 轮摘要上的输出速度（tok/s，仅供参考） | 旁路：`stores/turn-speed.ts` 只订阅 `observation.onEventApplied` 并读取显示中的轮 id，按本页生命周期保存；`lib/turnSpeed.ts` 计算（本轮新增输出 token ÷ 模型出字时长，用 Host 事件时间，不计工具执行）。没从开头看到、中途漏看事件或中途压缩的轮不显示（切回 Work 时从存档点补收的事件也算看到，所以运行中切走再切回多半仍能算出）；出字不到 1 秒的轮不显示；对话主流程不等待、不依赖它 | `ConversationTurnSummary.vue` 读 `speedOf(section.id)`；运行结束交给历史时按位置换到历史轮 id | `turnSpeed.test.ts`；`appInteraction.test.mjs` 的运行中轮显示速度 |
| `/new`、Reload、Resume、Tree、Fork、Clone | `operations.rs` 持原 operationId、冻结目标、结果；`SessionContent` 先接纳真实替换，编辑认领另算 | `SessionManager.vue`、`command-console.ts`、`stores/operations.ts`、`operationBinding.ts`；Tauri typed commands。Resume 与新建 Work 的保存 Session 列表共用 `SavedSessionList.vue` / `savedSessions.ts`，都读 Host 的 `session.inventory` 并自动续读后续页 | `sessionReload.test.mjs`、`submitDraft.test.mjs`、core operation/observation 测试；列表分页的 Host/Rust 链路见根目录 `test:client-protocol` |
| 输入、Queue、发送、模型/Stop 等控制 | `composer.ts` / `stores/input.ts` 拥有一个编辑器；core operation 是结果事实；`stores/app.ts` 保本地编辑 revision | `InputRegion.vue`（输入卡片：整行文字区 + 按钮行 附件/工作区│快捷按钮│命令/发送，无独立底栏）、快捷按钮 `lib/quickButtons.ts` + `stores/quick-buttons.ts`（本机 `aludock.quickButtons`，设备级、跨 Host；编辑在命令面板的图钉和 `QuickButtonsEditor.vue`，排序靠把手拖动 `lib/dragReorder.ts`（Pointer Events，鼠标和触屏通用）或方向键；立即发送是 `submit_message` 的 `textOnly`：不认领编辑器、不带附件和取回图片，但带上所属 `sessionId`，发送中的防重复判断按它对号）、`OperationResults.vue`、`StopRunPill.vue`（运行中才出现的「中止当前回复」悬浮胶囊，计时取对话里的运行中 turn）、`ConnectionStatus.vue`（顶栏连接灯与弹层，刷新也在命令面板 `lib/localCommands.ts` 的 `refresh`）、`stores/work-actions.ts`；`captureOperationTarget` 与需要可靠编辑保存的 `captureOperation` 分开 | App 真实控件门；普通输入、展开输入及 IME 须实际交互检查 |
| 上传原件、拖入、粘贴、取消、移除及重绑 | `attachment_jobs.rs` 持源、目标、进度、receipt/失败/unknown；`SessionMedia` 持文件；Vue 只保当前选择。桌面拖入和资源管理器复制的文件由 `src-tauri/src/file_handoff.rs` 从系统拖放事件和剪贴板取路径，页面只拿到拖放编号，之后与选择文件走同一暂存；截图粘贴仍传图片字节 | `stores/attachments.ts`、`AttachmentCard.vue`、`InputRegion.vue` 的拖入提示；pick/drop/paste stage、start/snapshot；typed attachment API | `attachmentMediaProtocol.test.mjs` + public Rust example；既有 upload-job 测试；本轮未改上传时不重跑 |
| 对话图片、Agent 发布图片、放大和保存 | `session_media.rs` 的文件、别名、flight；`conversation_images.rs` / `published_files.rs` 的传输校验；Tauri 只做平台交付 | `stores/conversation.ts`、`ConversationImage.vue`、`ImagePreviewDialog.vue`；`aludock-media`、`published_image`、`save_preview_image` | core `published_files` / media 测试；`appInteraction.test.mjs --files-reading`；Tauri save/URI helper |
| 切 Work/F5 的阅读位置、跟随和布局变化 | 只有 `conversationViewport.ts` 写滚动；`localState.ts` 存小型 DOM-free 阅读意图 | 实际 read/replace 绑定 Host epoch/Work/Session；scroll、图片布局、加载更早、返回底部 | `conversationViewport.test.ts`；实际浏览器滚动/选择/渐进内容，不能用截图代替手感 |
| 面板、弹窗、Extension UI 与焦点 | `stores/surfaces.ts` 只管显示/focus；`stores/control-panel.ts` 管配置查询；Extension 问题随 Work 的观察到达（core `InstanceDeliveryContext` 要求共享问题，bootstrap 的 `extensionUi.sharedQuestions` 告诉界面），回答和宽度经 `respond_shared_interaction` / `set_shared_widget_viewport` 发出，不取操作连接；Work 所在 Host 不支持时才沿 core 控制连接（`ExtensionControlState`）的旧方式 | `PageDialogs.vue`、`ControlCenter.vue`、`ExtensionUiSurface.vue`、`extension-ui` store；扩展的编辑器文字和标题只在实时到达时应用（core 跳过重连补收的，界面跳过 F5/切回的回放），不改此间写的草稿；输入保持同一节点 | `appInteraction.test.mjs`（共享问题打开、回答、别处回答后关闭、回放不改草稿；旧方式的接手与恢复）；core `conversation::tests` 旧 Host 退回；OS IME、Android Back 和实际 WebView 另核 |
| workspace、deliverables、文件打开 | core `workspace_files.rs` / `deliverables.rs`；Tauri `WorkspaceFileState` / 平台 staging / 下载记录 | `stores/deliveries.ts`、Workspace browser、下载面板；用户保存位置只由 OS dialog 产生 | 对应 core / Tauri 文件测试；真实文件提供者检查 |
| 工作区命令区：`!` / `!!` shell 命令、流式输出、停止、「发给 agent」 | Host/Worker 的 `bash.run` / `bash.abort` 与 `bash.*` 事件（[control.md](control.md#用户-shell-命令bashv1)）；core `actions.rs` 的 `run_bash` / `abort_bash`；命令行是对话投影里的 `shell` item，由 `lib/conversation.ts` 从 live 事件或 `bash_execution` 记录产出 | `WorkspaceCommandArea.vue`（在 `WorkspaceBrowser.vue` 内）、`ShellRunRow.vue`（时间线与命令区共用）；`stores/work-actions.ts` 的 `runShell` / `abortShell`，`stores/input.ts` 的 `appendShellQuote`；Tauri `run_shell_command` / `abort_shell_commands`；边界见 [Conversation ownership](../../clients/official/CONVERSATION_ARCHITECTURE.md#turns) | `conversationPresentation.test.ts`；根目录 `pi-bash-real.test.ts` 走真 Host/Worker；命令区布局与发给 agent 需真实浏览器/真机 |
| Windows 托盘/away、Android 后台与文档 URI | `desktop_shell.rs`、`windows_launch.rs`、`android_documents.rs`；Vue `stores/platform.ts`（暂离在 `stores/observation.ts`） | 本地 lifecycle 与原生 pause/rebind；不以后台状态结束 Work 或清文件 | Linux 编译不等于 Windows/Android；按用户授权打 staging 包后进行真机验证 |

## Native 入口与 core 业务接口

`src-tauri/src/lib.rs` 只启动、装配状态和注册原有 IPC。连接选择保留在 `connection_state.rs`，配对和连接任务在 `connection.rs`；它们调用 core 的 registry、pairing 和 router，不实现认证或身份存储。其余入口分别在 `sessions.rs`、`work.rs`、`configuration.rs`、`observation.rs`、`extension.rs`、`attachment_import.rs`、`file_handoff.rs`；`media.rs`、`file_delivery.rs`、`workspace_files.rs` 负责原生文件交付，`away.rs` 负责 Windows 离开提醒。

内部依赖由入口指向连接选择和平台文件能力，不经过共享大对象或入口间循环调用。Tauri 的观察任务只负责投递和 ACK；正文、续读以及不暴露路径/凭据的显示结果由 core 产出。

供其他原生入口复用的接口归各自业务模块：

- `actions::RestoredImageState` 持有 Queue 取回图片及其目标，`dequeue` / `submit` 负责取回、发送和成功后的认领清理。它由 `SessionContent::restored_images()` 提供同一份状态；真实 Session/分支变化在 core 接纳时清理旧图片，不等待界面 Follow、回放或 ACK，变化前发出的迟到 Queue 回执也不能重新放回旧图片。`attachment_jobs::AttachmentState` 封装选择表，`capture_submission` / `finish_submission` 只回收本次发送捕获的已完成上传，不动新选择或未知结果。
- `config::CommandReferenceState` 保存不暴露私有路径的命令引用；`DockClient::run_catalog_command` 组装命令并提交，不以重新读取目录为前置。设置直接使用 Host 返回的定义，客户端不保第二份定义表。
- `sessions::SessionTokenState` 保存私有 Session 路径的本地引用。`SessionContent::check_target` 仅在同一 Host 的已接纳代数更新时拒绝旧目标；旧缓存、没有缓存及不同 Host 的缓存不能否决当前目标。Session 入口通过 `DockClient::with_host_epoch` 把原 Host 身份带到实际请求的握手检查，Host 重启后旧页面不会向新 Host 发送 Session 修改。Session 和工作区操作不再为核对目标拉整页对话或所有 Work；没有观察内容也不要求先读取。
- `operations::OperationAssociations` 保存操作结果，`OperationState` 和 `OperationFailure` 提供类型化状态/错误分类；core 不解析界面错误 JSON 决定是否未知。任务异常结束会收尾为未知，关闭界面不取消任务。`ConversationObservation::accept_session_result` 根据 core 的 `SessionChange` 应用成功回执；显示失败不改判远端操作失败。
- `extension_ui::ExtensionControlState` 持有控制连接、当前问题、回答和 viewport 状态；Tauri 只转交界面事件。迟到的回答回执不清除新问题，断线不代答。

各业务模块的 `presentation` 子模块只做原有 IPC 的路径/凭据隔离和显示形状转换，复用 core 枚举；不是第二套 Host 协议。普通工作入口继续沿原有 Vue IPC；配对只保留开始、进度和取消本次请求，不再提供恢复或丢弃入口。

### 本机连接资料与设置

- `host_registry.rs` 只管已保存 Host 的新增、移除和打开；`host_registry/catalog.rs` 拥有目录、选择与版本检查。重复配对已保存 Host 会被拒绝，不覆盖原凭据或连接设置，也没有隐藏的同 Host 身份替换功能。
- core `pairing.rs` 的一次授权只活在当前 future 中：新证书、PIN 和临时材料保存在内存，完成 SRP、server identity 的密码学验证和最终 exact-pin / mTLS / Protocol V2 确认后，才返回可保存的结果。Tauri 同步接纳开始命令并登记任务，再异步执行认证，避免旧页面的登记被排到页面退出之后；取消与最终保存互斥；主 WebView 开始重新加载或窗口销毁时，原生也会终止这些任务，不依赖 Vue 卸载。普通失焦或转入后台不取消配对，用户仍可去 Host 输入 PIN。Vue 用本次请求 ID 隔离迟到进度和回执，退出配对界面会取消当前请求。
- 最终保存和移除共用资料根目录的 OS 文件锁，取得锁后再读目录快照，独立打开的客户端/CLI 不能把另一份已保存资料当作残留删除。文件锁复用 `private_fs.rs` 中供 `run_cache.rs` 使用的步骤，不增加事务日志。成功结果在自有私有临时目录完整写好，再发布为 `hosts/<host-id>` 并提交目录快照。保存失败清理自己的临时目录；重开不会认领未登记目录，也不会续办未完成授权。若进程在发布目录与提交快照之间退出，下一次显式完成的新授权可清理对应 Host 的未登记旧目录后保存，不要求它还包含完整凭据，也不自动恢复旧授权。删除正式目录时先同父目录改名到唯一隐藏清理位置并同步，再递归清理；清理中断只留下垃圾，不占据新保存的正式路径。
- `storage.rs` 继续读取现有 0.2.12 的 identity/pairing manifest、凭据和 metadata，未扩展成功记录格式。只保留当前 registry schema 2 和当前 identity/pairing schema 1；不执行旧单 Host、flat 文件或旧 registry schema 的迁移。旧 pending/transaction 文件不再读取或提升，不为升级增加磁盘清理引擎。
- `preferences.rs` 与 `connections.rs` 各自负责数据含义和格式检查，`storage/snapshots.rs` 只复用版本检查、查找与旧快照清理。连接资料继续接受当前客户端已经保存的历史后缀文件名，不套用 Host 目录的文件名规则。
- `private_fs.rs` 复用私有路径校验、按需权限修复和原子新文件发布，`fs_publish.rs` 保留跨平台不覆盖提交。正常读取仍检查路径和凭据权限，但正确权限不重写，也不执行无变化的清理同步。目录/profile/preferences 仍有版本冲突保护。
- 配对失败、取消或退出后只能显式重新开始。最终回包丢失可能在 Host 留下闲置设备授权，由用户在现有 Devices 页面移除；客户端不以 provisional pin 恢复授权，不自动撤销或补偿。
- `cargo test --locked -p aludock-client-core` 覆盖当前格式重开、重复配对保留原资料和保存失败后的再次保存；`node tests/appInteraction.test.mjs` 走真实 Vue 配对控件和 IPC fixture。根目录 `npm run build` 后，在 `clients/official/` 运行 `pnpm test:pairing`，通过 loopback TLS 和真实 Rust public API 验证完整认证、丢失/篡改回包、取消及新授权，不启动 Host/Worker 或模型。

## 会话与编辑的长期规则

1. 一份 canonical 内容在 core，一条完整投影在 Vue。`App.vue` 只摆放区域、按序启动监听，不成为页面级恢复器、上传器或操作账。各区域从对应 store 读取事实、调用明确动作。
2. 普通断连、同目标刷新和背景暂停不清已确认的内容/本地编辑；连接变化收敛到顶栏标题前的连接状态灯及其弹层。不得恢复会话区的全局黄色恢复横幅，或借失败去全页重新加载。
3. 真实 Session/分支替换立即切内容归属，不等 Follow 握手、历史读完或旧 Extension 释放；回执与事件按原生身份/顺序接纳，不凭文本或名称猜同一条消息。
4. 发送清稿与 Session 返回内容替换，分别核对操作目标、原编辑 revision 与当前页面；Queue 取回不是替换，成功时把返回消息按原顺序插到当时草稿前、附件加入现有待提交区，不保存按下时的草稿快照或要求二次追加。没收到结果时不自动重发；迟到成功不能吞新草稿。编辑保存失败不假装已发送/已清除；返回内容与仅待确认的已应用标记同次保存，确认后回收，F5 不重复追加。Stop/模型等不认领编辑器的控制不被无关草稿存储错误阻塞。
6. 客户端只在三种情况下禁用或拦下一个操作：同一操作已经在进行（防重复点击）、继续会丢失本地草稿或文件、有已确认的需求明确要求。其余并发（压缩中发送、Session 操作、控制面板、中止等）交给 Host 接纳，Host 拒绝时显示普通提示。没收到结果（连接中断、超时）按普通失败处理：发起的地方提示一次「连接中断，没收到结果。请稍后再试。」；发起的地方已不在屏幕上时，和普通失败一样进 Work/工作列表的操作结果，显示「没收到结果」，点「知道了」收起。不另设“未确认”提示、不设刷新确认按钮、不锁发送或其他操作；做没做成，用户看对话和 Work 状态就知道。进度说明不用红色错误样式。中止只发一次 `command.abort_restore_queue`，取回内容按第 4 条的 Queue 取回规则插入；已交给 Agent 的消息只提示无法取回。
5. 历史、某条正文、某张图片独立可用和报错。图片不等整页正文，坏文件不清掉其他内容；恢复不得主动抢编辑焦点。已知失败的处理建议必须在对应入口可执行。

## 文件从哪里来、活多久

- 本地选取的文件与 clipboard/Android URI 导入同一个 `RunCache`，sync 后发布私有不可变源。上传、preview 和可信 receipt 关联的正式图片共享这个源。普通非图片文件仍可上传。
- `file_transfer.rs` 持有 `file-transfer.v1` 的共用双向收发、有限消费窗口、计数和摘要核验。交付、工作区、published 图片及 resource/system 正文默认走连续读取；只有明确缺能力且未开始数据时使用原帧/页 API。Published 文件在新模式有远端 SHA 验证，旧 Host 的分页 fallback 才只有本地摘要。`conversation_images.rs` 保持原生 `conversation.image` 行为，不改成磁盘来源。资源阅读由 Rust core 完整读取，Vue 只显示/复制结果，不自行续页。
- 原生根据真实稳定连接 authority、Machine、fileId、MIME 和源描述关联 receipt；opaque ref 不拆解，文件名不当身份，Vue 不用附件预览覆盖正式图片。请求域与文件寿命分开。
- 所有对话/发布/附件图片都返回 `MediaHandle`。URL 只通过受限 `aludock-media` 解析注册的 handle，WebView 没有任意路径读权限。显示 prune、F5、Work 切换只释放显示资源，不删可信文件。
- 图片保存传 `{handle, name}`，不 fetch URL 到 JS，不把 Uint8Array 再传回 Rust。core 流式复制并复核本地长度/SHA；Tauri 复用原 dialog、staging、atomic commit/Android URI copy。保存任务持有自己的临时文件直到完成；取消/错误只清自己的临时文件，不能删原件。Dialog/URI 的平台差异仍在 Tauri。
- `ConversationObservation` 的 owner 显式选择 [instance records](control.md#readfollow-与-extension-ui-操作)，完整接收初始内容与独立 live 事件；初始 ready 之前不提交，换 owner 丢弃未完成记录。每个 owner 固定协商结果，仅首次数据前明确缺能力才使用原 V2，旧 public read/follow 默认不变。
- 正文与会话增量保留在原生内存，仍由 `SessionContent` 唯一持有。当前成员、checkpoint、Segment 和实际 binding 共享不可变正文引用，旧版本最后一个引用释放后回收；不再创建逐条正文文件或磁盘 journal。Host 返回历史后即可按原有分批接口显示，不以前置写盘/权限/摘要回读作为首屏条件。
- 正文在本次原生生命周期内保留，支持 F5 和切 Work，不承诺重启持久化。媒体可信文件仍保留；正常退出释放 RunCache，下次启动仅清无活动 lease 的私有残留，不动用户原文件、主动保存的文件或 Host 附件。不承诺异常退出后的永久内容恢复。

## 阅读位置是本客户端的显示意图

`conversationViewport.ts` 同时负责当前 DOM 锚点和可序列化位置：稳定 row/part ID、相对偏移、可匹配的短文本/同句 occurrence、跟随意图。没有第二个 viewport 或内容读取器。

位置通过 `localState.ts` 的独立小 localStorage 记录保存，键是连接/Work，内容还核对实际 Host epoch 和 Session。它不属于 native 内容事实，也不和所有草稿一起序列化；滚动暂停后合并写入，pagehide/隐藏/切 Work 同步保存。这是为 F5 生命周期选择的显示层落点，不新增两条 IPC 或异步 flush 窗口，也不作额外跨进程恢复承诺。

从其他 Work 切入（包括 A→B→A）是新的查看动作，默认跟随最新底部，不读取该 Work 上次离开时的位置。只有当前对话连续停留期间的主动上翻才保持阅读锚点；同 Work 重绑沿用本次阅读意图。页面重建的首次绑定仍可恢复同一 Work 的已存位置，不改变既有 F5 行为。

需要恢复时，渐进内容出现对应 ID 即可恢复，不等所有历史。原文本暂时未展开/未呈现时先停在已确认条目起点，不把旧长正文的像素偏移套到短预览；文本出现后可继续定位，用户新动作则立即接管。后续正文/图片布局继续沿当前锚点；wheel/touch/滚动条/导航键等用户意图优先取消旧恢复。相同 Session 的 reload 不自动当成新会话，真 Session 换新不套旧位置。原条目不在当前分支/已保留内容时，在 seed 完成后回到当前目标末尾，不为旧坐标自动扫描历史或反复定位。存储失败保留原有效记录并提示，不阻输入/滚动。

## 资源边界与失败

- 正文读取以实际可见 interest/显式重试为需求边界，不自动扫全部 incomplete；纯图（含空工具结果身份块）走媒体 owner，必要长文字继续自动补全。官方 Rust reader 显式选择 `conversation.references.v1` 的引用视图；短混排可由完整 descriptor 接纳，长混排补全只取得文字、工具信息和原位置的图片引用，图片字节仍归媒体 owner。长正文在引用视图中优先用一次 `conversation.content.stream` 连接，增量 JSONL 直接交既有 assembler；仅 ready 前明确缺 stream/字节能力时沿用同一引用视图分页。只有 Host（含目标 SubHost）明确缺引用视图能力时回到原 V2 图片段；旧 Host 下不能以局部 image API 的缓存命中推断整页正文无传图。
- 永久上传 fileId 不依赖当前运行的 source/job，仍核原目标域并交 Host 接纳；未完成选择继续要求有效 job。成功发送或进入 Queue 后，只清理本次发送前捕获的已完成上传任务，不删除 Host 附件或可信媒体缓存；失败/未知不清理。未接纳的导入撤销，不另设“保留附件”或上传历史界面。
- 正文为共享 `Arc<str>` JSON，增量为 Segment 内存提交列表；binding 按 `session_journal.rs` 原有 256 KiB / 64 条预算回放，正文按 32 KiB UTF-8 边界切块，Vue 只组装当前一条记录。大单个源事件不截断。旧版本按实际引用释放，当前可信成员不为“达标”被丢弃。
- 图片/发布文件共用现有三个传输许可；接收只保协议 chunk，不预分配整文件 Vec。文件长度、chunk 和协议限制由各产出端常量定义，入口复用，不再另设未经测量的 128 MiB Blob 预算。
- 会话媒体的 Vue 层持 descriptor/handle URL，图片首次接近 viewport 时按需读取，已加载的 img 留在当前会话 DOM，不随滚动反复销毁/重建或替换占位；浏览器负责自身解码缓存，预览只持当前图。该链路的主线程不做图片字节拼装/复制/保存往返；workspace 预览仍归自己的文件 owner，不在这里另建通用文件平台。无用的显示引用和 Work 的工具展开状态在退场时释放。
- Tauri URI API 的响应仍要求 Vec，WebView 解码像素和显示正文也占内存；这些不等于文件字节。没有虚构精确全 App/RSS 或磁盘硬上限。可信文件保留与任意硬磁盘上限不能同时保证，因此不静默淘汰文件再下载。媒体存储失败沿图片/正文内媒体导入/保存入口明确反馈，原成功内容不倒退。
- 后续若调整预算，应据真实设备的文件、像素和峰值证据，在对应 owner 内收敛；不能用不响应、删历史或抬协议上限替代修复。

## 验证与交付入口

按 [QA](../qa.md) 选择改动对应的最小入口：core Cargo、Tauri `check --tests`/相关 helper、`vue-tsc --noEmit`，以及上表相应测试。改完完整用户结果再集中检查，不逐字段重复全套。

`appInteraction.test.mjs` 的 `--files-reading` 只走当前图片显示/handle 保存的真实 Vue 控件与 native IPC fixture；viewport 测试是 DOM 边界几何，不冒称浏览器或真机。正式 protocol/content/upload 门各验证不同链，不为未改模块重复执行。真实 Host/Worker 子进程必须隔离 HOME/XDG/Pi/provider；任何外部模型替身只能按已授权的 loopback 固定 transport，不能携带真实 provider 凭据。

源码编译、App fixture、Chrome、真实 Tauri/Windows/Android、WAN 分开报告。截图只能证明布局；用户感受的输入连续性、滚动、前后台和取消/保存须实际操作。安装、staging 打包、managed service 和真实模型调用按用户授权执行，不为交付报告自行启动。

附件 Skill 的源码是根目录 `skills/dock-attachments/SKILL.md`，由 `src/pi/pi-agent-adapter.ts` 的 bundled skill 路径发现。只有任务需要原文件处理时才加载，附件 metadata 存在本身不是触发条件；普通图片聊天走已有视觉输入。源码/发现入口核对不等于已安装或真实触发验收。
