# 官方 Desktop / Android Client

## 先确定改的是哪件事

官方客户端是 Alu Dock 的第一方入口，不持有 Agent runtime。产品依据是 [STORY](../../STORY.md) 和 [客户端设计理念](../client-design-principles.md)；开发约定见 [official AGENTS](../../clients/official/AGENTS.md)，会话接纳、回放和界面分工的细节见 [Conversation ownership](../../clients/official/CONVERSATION_ARCHITECTURE.md)。本文按用户动作定位实际所有者，不是另一份实施计划。

```text
App / 区域组件 → Vue 专属交互 owner → typed bridge
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
| 连接、配对、地址、切 Host、目录刷新 | core `host_registry.rs` / `connection_router.rs` / `pairing.rs`；Tauri `ConnectionRuntimeState`；Vue store 只保最后接纳的目录与本地选择 | `hostConnection.ts`、`stores/app.ts`、`ConnectionLanding.vue`、Host 设置；`bridge.ts` → Tauri `connection.rs` / `connection_state.rs` → core | core 连接/registry 测试；App native-boundary 门；真实配对/切网须设备检查 |
| 进入 Work、断连续读、前后台恢复 | core `observation.rs` 续读；`SessionContent` 接纳内容与身份；Vue `workObservation.ts` 订阅和确认，不拥有另一份会话 | `start_conversation_follow` / `read_conversation_content` / ACK；`conversationSession.ts` → `conversationContent.ts` → `ConversationView.vue` | `contentProtocol.test.mjs`、core observation/content 测试；仅改局部时不要重复整条门 |
| 历史、正文、记录错误和重试 | `session_content_reader.rs` 的分页/任务；`session_records.rs` 的不可变内存正文；`session_content/binding.rs` 的有界显示回放 | `ConversationRegion.vue` 的加载更早/重试/可见条目；不直接调用远端正文分页 | content 门、冷打开/回放测试；App 局部接线 |
| `/new`、Reload、Resume、Tree、Fork、Clone | `operations.rs` 持原 operationId、冻结目标、结果；`SessionContent` 先接纳真实替换，编辑认领另算 | `SessionManager.vue`、`command-console.ts`、`operationResults.ts`、`operationBinding.ts`；Tauri typed commands | `sessionReload.test.mjs`、`submitDraft.test.mjs`、core operation/observation 测试 |
| 输入、Queue、发送、模型/Stop 等控制 | `composer.ts` / `inputEditor.ts` 拥有一个编辑器；core operation 是结果事实；`stores/app.ts` 保本地编辑 revision | `InputRegion.vue`、`OperationResults.vue`、`workActions.ts`；`captureOperationTarget` 与需要可靠编辑保存的 `captureOperation` 分开 | App 真实控件门；普通输入、展开输入及 IME 须实际交互检查 |
| 上传原件、粘贴、取消、移除及重绑 | `attachment_jobs.rs` 持源、目标、进度、receipt/失败/unknown；`SessionMedia` 持文件；Vue 只保当前选择 | `attachmentUploads.ts`、`AttachmentCard.vue`；pick/stage/start/snapshot；typed attachment API | `attachmentMediaProtocol.test.mjs` + public Rust example；既有 upload-job 测试；本轮未改上传时不重跑 |
| 对话图片、Agent 发布图片、放大和保存 | `session_media.rs` 的文件、别名、flight；`sessions.rs` / `published_files.rs` 的传输校验；Tauri 只做平台交付 | `conversationRegion.ts`、`ConversationImage.vue`、`ImagePreviewDialog.vue`；`aludock-media`、`published_image`、`save_preview_image` | core `published_files` / media 测试；`appInteraction.test.mjs --files-reading`；Tauri save/URI helper |
| 切 Work/F5 的阅读位置、跟随和布局变化 | 只有 `conversationViewport.ts` 写滚动；`localState.ts` 存小型 DOM-free 阅读意图 | 实际 read/replace 绑定 Host epoch/Work/Session；scroll、图片布局、加载更早、返回底部 | `conversationViewport.test.ts`；实际浏览器滚动/选择/渐进内容，不能用截图代替手感 |
| 面板、弹窗、Extension UI 与焦点 | `pageSurfaces.ts` 只管显示/focus；`controlPanel.ts` 管配置查询；Extension 状态/回调仍沿 core 控制连接 | `PageDialogs.vue`、`ControlCenter.vue`、`extension-ui` store；输入保持同一节点 | App/Session 门；OS IME、Android Back 和实际 WebView 另核 |
| workspace、deliverables、文件打开 | core `workspace_files.rs` / `deliverables.rs`；Tauri `WorkspaceFileState` / 平台 staging / 下载记录 | `deliveries.ts`、Workspace browser、下载面板；用户保存位置只由 OS dialog 产生 | 对应 core / Tauri 文件测试；真实文件提供者检查 |
| Windows 托盘/away、Android 后台与文档 URI | `desktop_shell.rs`、`windows_launch.rs`、`android_documents.rs`；Vue `platformLifecycle.ts` | 本地 lifecycle 与原生 pause/rebind；不以后台状态结束 Work 或清文件 | Linux 编译不等于 Windows/Android；按用户授权打 staging 包后进行真机验证 |

## Native 入口与 core 业务接口

`src-tauri/src/lib.rs` 只启动、装配状态和注册原有 IPC。连接选择保留在 `connection_state.rs`，配对和连接任务在 `connection.rs`；它们调用 core 的 registry、pairing 和 router，不实现认证或身份存储。其余入口分别在 `sessions.rs`、`work.rs`、`configuration.rs`、`observation.rs`、`extension.rs`、`attachment_import.rs`；`media.rs`、`file_delivery.rs`、`workspace_files.rs` 负责原生文件交付，`away.rs` 负责 Windows 离开提醒。

内部依赖由入口指向连接选择和平台文件能力，不经过共享大对象或入口间循环调用。Tauri 的观察任务只负责投递和 ACK；正文、续读以及不暴露路径/凭据的显示结果由 core 产出。

供其他原生入口复用的接口归各自业务模块：

- `actions::RestoredImageState` 持有 Queue 取回图片及其目标，`dequeue` / `submit` 负责取回、发送和成功后的认领清理。它由 `SessionContent::restored_images()` 提供同一份状态；真实 Session/分支变化在 core 接纳时清理旧图片，不等待界面 Follow、回放或 ACK，变化前发出的迟到 Queue 回执也不能重新放回旧图片。`attachment_jobs::AttachmentState` 封装选择表，`capture_submission` / `finish_submission` 只回收本次发送捕获的已完成上传，不动新选择或未知结果。
- `config::CommandReferenceState` 保存不暴露私有路径的命令引用；`DockClient::run_catalog_command` 组装命令并提交，不以重新读取目录为前置。设置直接使用 Host 返回的定义，客户端不保第二份定义表。
- `sessions::SessionTokenState` 保存私有 Session 路径的本地引用。`SessionContent::check_target` 仅在同一 Host 的已接纳代数更新时拒绝旧目标；旧缓存、没有缓存及不同 Host 的缓存不能否决当前目标。Session 入口通过 `DockClient::with_host_epoch` 把原 Host 身份带到实际请求的握手检查，Host 重启后旧页面不会向新 Host 发送 Session 修改。Session 和工作区操作不再为核对目标拉整页对话或所有 Work；没有观察内容也不要求先读取。
- `operations::OperationAssociations` 保存操作结果，`OperationState` 和 `OperationFailure` 提供类型化状态/错误分类；core 不解析界面错误 JSON 决定是否未知。任务异常结束会收尾为未知，关闭界面不取消任务。`ConversationObservation::accept_session_result` 根据 core 的 `SessionChange` 应用成功回执；显示失败不改判远端操作失败。
- `extension_ui::ExtensionControlState` 持有控制连接、当前问题、回答和 viewport 状态；Tauri 只转交界面事件。迟到的回答回执不清除新问题，断线不代答。

各业务模块的 `presentation` 子模块只做原有 IPC 的路径/凭据隔离和显示形状转换，复用 core 枚举；不是第二套 Host 协议。Vue IPC 名称、参数与结果形状不变。文件传输和本机存储的内部实现没有随这次拆分重写。

## 会话与编辑的长期规则

1. 一份 canonical 内容在 core，一条完整投影在 Vue。`App.vue` 只组合区域，不成为页面级恢复器、上传器或操作账。区域只接收自己的只读事实和明确意图。
2. 普通断连、同目标刷新和背景暂停不清已确认的内容/本地编辑；连接变化收敛到底栏。不得恢复会话区的全局黄色恢复横幅，或借失败去全页重新加载。
3. 真实 Session/分支替换立即切内容归属，不等 Follow 握手、历史读完或旧 Extension 释放；回执与事件按原生身份/顺序接纳，不凭文本或名称猜同一条消息。
4. 发送清稿与 Session 返回内容替换，分别核对操作目标、原编辑 revision 与当前页面；Queue 取回不是替换，成功时把返回消息按原顺序插到当时草稿前、附件加入现有待提交区，不保存按下时的草稿快照或要求二次追加。结果未知不自动重发、不换 operationId；迟到成功不能吞新草稿。编辑保存失败不假装已发送/已清除；返回内容与仅待确认的已应用标记同次保存，确认后回收，F5 不重复追加。Stop/模型等不认领编辑器的控制不被无关草稿存储错误阻塞；新的 Stop 意图不被旧控制 unknown 永久锁住，人工刷新确认可继续新意图但不改旧结果。
5. 历史、某条正文、某张图片独立可用和报错。图片不等整页正文，坏文件不清掉其他内容；恢复不得主动抢编辑焦点。已知失败的处理建议必须在对应入口可执行。

## 文件从哪里来、活多久

- 本地选取的文件与 clipboard/Android URI 导入同一个 `RunCache`，sync 后发布私有不可变源。上传、preview 和可信 receipt 关联的正式图片共享这个源。普通非图片文件仍可上传。
- `conversation.image` 逐块验证完整性；`file.read` 沿既有分页/parser 写 sink，并核实例、offset、DTO、epoch/runtime 和完整长度。后者没有远端 SHA 字段，`PublishedFileTransfer.sha256` **只描述实际收到的本地字节**，不得称为远端摘要认证。
- 原生根据真实稳定连接 authority、Machine、fileId、MIME 和源描述关联 receipt；opaque ref 不拆解，文件名不当身份，Vue 不用附件预览覆盖正式图片。请求域与文件寿命分开。
- 所有对话/发布/附件图片都返回 `MediaHandle`。URL 只通过受限 `aludock-media` 解析注册的 handle，WebView 没有任意路径读权限。显示 prune、F5、Work 切换只释放显示资源，不删可信文件。
- 图片保存传 `{handle, name}`，不 fetch URL 到 JS，不把 Uint8Array 再传回 Rust。core 流式复制并复核本地长度/SHA；Tauri 复用原 dialog、staging、atomic commit/Android URI copy。保存任务持有自己的临时文件直到完成；取消/错误只清自己的临时文件，不能删原件。Dialog/URI 的平台差异仍在 Tauri。
- 正文与会话增量保留在原生内存，仍由 `SessionContent` 唯一持有。当前成员、checkpoint、Segment 和实际 binding 共享不可变正文引用，旧版本最后一个引用释放后回收；不再创建逐条正文文件或磁盘 journal。Host 返回历史后即可按原有分批接口显示，不以前置写盘/权限/摘要回读作为首屏条件。
- 正文在本次原生生命周期内保留，支持 F5 和切 Work，不承诺重启持久化。媒体可信文件仍保留；正常退出释放 RunCache，下次启动仅清无活动 lease 的私有残留，不动用户原文件、主动保存的文件或 Host 附件。不承诺异常退出后的永久内容恢复。

## 阅读位置是本客户端的显示意图

`conversationViewport.ts` 同时负责当前 DOM 锚点和可序列化位置：稳定 row/part ID、相对偏移、可匹配的短文本/同句 occurrence、跟随意图。没有第二个 viewport 或内容读取器。

位置通过 `localState.ts` 的独立小 localStorage 记录保存，键是连接/Work，内容还核对实际 Host epoch 和 Session。它不属于 native 内容事实，也不和所有草稿一起序列化；滚动暂停后合并写入，pagehide/隐藏/切 Work 同步保存。这是为 F5 生命周期选择的显示层落点，不新增两条 IPC 或异步 flush 窗口，也不作额外跨进程恢复承诺。

从其他 Work 切入（包括 A→B→A）是新的查看动作，默认跟随最新底部，不读取该 Work 上次离开时的位置。只有当前对话连续停留期间的主动上翻才保持阅读锚点；同 Work 重绑沿用本次阅读意图。页面重建的首次绑定仍可恢复同一 Work 的已存位置，不改变既有 F5 行为。

需要恢复时，渐进内容出现对应 ID 即可恢复，不等所有历史。原文本暂时未展开/未呈现时先停在已确认条目起点，不把旧长正文的像素偏移套到短预览；文本出现后可继续定位，用户新动作则立即接管。后续正文/图片布局继续沿当前锚点；wheel/touch/滚动条/导航键等用户意图优先取消旧恢复。相同 Session 的 reload 不自动当成新会话，真 Session 换新不套旧位置。原条目不在当前分支/已保留内容时，在 seed 完成后回到当前目标末尾，不为旧坐标自动扫描历史或反复定位。存储失败保留原有效记录并提示，不阻输入/滚动。

## 资源边界与失败

- 正文读取以实际可见 interest/显式重试为需求边界，不自动扫全部 incomplete；纯图（含空工具结果身份块）走媒体 owner，必要长文字继续自动补全。混合图文的整记录补全仍经过既有 V2 图片段，不能以局部 image API 的缓存命中推断整页正文无传图。
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
