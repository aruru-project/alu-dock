# Hub 与 Session Work TUI

## 这部分负责什么

Alu Dock 的 SSH 界面由两个客户端 surface 组成：

- **Hub**：创建、继续和管理 Dock instance；
- **Session Work**：连接一个 instance，与当前 Agent session 交互。

Hub 和 Work 的运行中 Agent 工作能力都通过 DockClient 和 Protocol V2 使用 Host Service，不持有 Agent runtime，也不读取 Agent 私有 session 文件。本机管理页面有两类明确例外：Devices/attachment directory 直接管理当前用户的 Host private state；Settings → Pi 直接使用随包 Pi 的 public API 管理当前用户原生 Pi environment。两者都不形成可供远程调用的 Dock admin 协议，Hub 也不保存或投影 Agent 凭据。

```text
Hub / Work ───── Protocol V2 ──────── Host control/session gateway ── Worker
Hub Settings/Devices ── local private state ── managed Host network/storage authority
Hub Settings → Pi ───── bundled Pi API ─────── Pi settings/auth/packages
```

## Hub

Main Hub 的主要对象是 Dock instance。它提供 New、Continue、History、persisted sessions、Settings、Devices、Machines 和 Leave 等入口，但打开 Hub 本身不创建 runtime。没有角色设置时 Dock 默认是 Main；不存在独立 Standalone 界面。

Settings 管理 Pi、永久 attachment directory 和下一次启动角色。Pi 页面按 Pi 当前实际环境列出 Providers/models/default，显示非秘密 access 状态，并调用 Pi 原生 API-key 或 OAuth login/logout；secret 输入在终端中遮蔽，OAuth URL/device code/progress 由 Pi flow 提供。凭据仍由 Pi 写入和刷新自己的 `auth.json`，Hub 不显示 secret、不维护 model catalog，也不向 Main/SubHost 之间复制配置。Extension 安装使用页面提示的 `aludock pi:install <source>`；已运行 Work 用 `/reload` 采用变化。

首次选择 SubHost 时先导入 Main 创建的一次性 join file；Main 的可达地址和当前 Machine port 随文件带入，本机名称默认使用系统机器名，用户只在确认页明确选择 Edit Details 时才修改这些值。导入会同时保存待完成的 enrollment 与连接设置，并明确提示在 join 有效期内使用普通 Host 入口重启，不再把同一 join file 传给启动进程；若未及时启动，界面要求从同一个 Main 生成新文件并复用原 SubHost identity。选择 Main 只清除 SubHost role override，保留 enrollment 与连接设置；以后切回同一 Main 是一次确认，不再询问地址、端口、名称或 join file。Edit Connection 只修改同一 Main 的连接事实，Connect to a Different Main 才要求新 join file 并明确替换 enrollment。旧版本留下 enrollment 但缺少连接设置时，界面复用已有机器名和默认端口，只询问无法恢复的 Main 地址。确认页取消不修改任何事实；保存后但尚未重启时，Settings 明确显示 `SubHost next start` 并允许选择 `Use as Main Instead` 撤销。角色 change 只在下次 Host 启动生效，不在正在运行的 Host 内热换 Registry 或 authority。附件目录输入必须是 Host 上的绝对路径；设置归 Host storage authority，TUI 不保存上传 bytes，也不向远程 API 暴露设置。已有附件时页面拒绝直接切换到另一空目录，避免让既有 `fileId` 静默失效。

Machines 只在 Main 的完整 Hub 中出现，实时开关 SubHost connections、修改 Machine port、保存一次供新 SubHost 使用的 Main 可达地址、显示 SubHost connected/unavailable 状态、创建一次性 join file，并可在确认后移除 SubHost。可达地址只在首次 Connect 或用户明确选择 Address 时输入；端口直接取 Machines 当前设置。TUI 创建的 join file 同时携带这两个非秘密连接事实，因此另一台电脑不再照抄端口或重复输入地址。Turn On & Connect 会先等待 Host 确认端口已经监听，再创建 join file；绑定失败时留在 Machines 并说明可以更换端口或重试。关闭 connections 会断开 machine links，但保留 trust、routes 和 SubHost 上的 Worker/work；再次打开后已配对 SubHost 可以重连。移除会立即撤销 Main 保存的 trust、断开当前 machine link，并让该 SubHost 的 work 从 Main 消失；它不会停止 SubHost 上的 Worker 或 work，重新使用必须再次 join。SubHost 的本机 TUI 明确显示 `Alu Dock SubHost` 和是否连接 Main，只提供本机 Pi 环境、连接设置与下次切回 Main；它没有 New、Continue、History、Devices 或 Work 入口。Main 断线不让 SubHost 自行升格，也不开放临时客户端 endpoint。

Devices 是唯一远程设备入口：同一页显示 Remote Access 开关、listener 状态、port、五分钟连接窗口、等待请求和已保存设备。Remote Access 默认关闭；用户选择连接新设备后仍必须在本机确认只连接自己持有的设备，才打开五分钟窗口。连接页保持显示时每 200ms 读取 Host-owned private state，倒计时、listener 状态、新请求、checking、成功和失败自动更新；没有 Refresh，也不靠重新进入页面发现变化。更新会按稳定 value 保留当前选择，只有新等待设备或新 terminal result 到来时才把焦点移到最相关动作。

等待设备被选中后直接进入四位 PIN 输入；Enter 即提交最终批准，不再经过“Enter Pairing PIN”或第二次确认。提交后页面先显示 checking，并由 Host 的配对状态文件接收成功/失败结果；窗口在一次成功、证明失败、手动停止、超时、listener disable 或 Host restart 时关闭，provisional 请求被清除。已保存设备选择后只有一次 removal confirmation；设备证书信任一直保留到用户确认移除。

Devices 列表项来自 Host 保存的短期 metadata，不对应等待中的 socket；客户端请求已经响应并关闭。页面只显示 remote access、port、倒计时、设备名、自然结果和下一步动作，不展示证书 fingerprint、pairing ID、SRP、内部 revision 或其他实现状态。证书证明、四位 PIN、五分钟窗口和成功后关闭窗口的网络安全语义不变。

Hub 使用 alternate screen；进入 Work 或离开前恢复 shell screen。Instance lifecycle 和 persisted-session inventory 来自 Host，不由 TUI 自己扫描 runtime。Hub 直接渲染 Protocol V2 的 `displayName`：显式 session name 优先，其次是 Dock instance key，最后才回退到项目目录；首条用户消息只用于 persisted-session inventory 的未命名 session 摘要，不参与当前 Dock instance 的 `displayName`。重名项由项目路径和相对时间区分，Hub 和默认人类列表不再把短 instance ID 当作名称。

Hub 的 Dock New 从启动 `aludock` 时的当前目录打开 workspace 列表，经 `workspace.list.v1` 返回上级和子目录后再确认 cwd。列表支持搜索、分页/跳页、直接输入路径和隐藏目录切换；隐藏目录默认不显示，但直接输入隐藏路径仍可进入。目录符号链接带标记并按 Host 返回的规范目标继续浏览。取消选择返回 Hub，不创建半成品 instance；确认后才调用 `instance.create(cwd)`。直接执行 `aludock new --cwd ...` 的既有入口不经过 Hub 选择器。

## Session Work

Work 的 `/resume`、`/tree` 和 `/fork` 只向用户提供搜索与选择器；session file 和 tree entry ID 只作为 TUI 调用 Protocol V2 时的内部选中值，不属于 Work 命令的人类语法。分支摘要、替换说明和 label 在选中会话点后的动作页面继续配置。

Work 的主要对象是一个已打开的 Dock instance。它负责：

- conversation、thinking、tool、compaction 与 Agent activity 的显示；
- prompt、Queue、model、settings、session/tree 与 Extension UI 的交互；
- 读取当前视图、跟随实时更新，以及独立恢复 Extension UI 操作连接；
- editor、viewport、focus、搜索和本地 modal 状态。

Work 使用可流动的 main buffer 和终端原生 scrollback/selection。Detach 只断开客户端，不停止 Host 中的 instance。

Pi Session Tree UI 只做一次逻辑 `session.tree.v2` 调用并得到完整 compact snapshot。搜索、过滤、active-first 顺序和折叠都在这份完整拓扑上本地完成；TUI 不收集业务分页、不维护 revision，也没有 partial/capped Tree 状态。大型 response 的 bounded transport framing 由 DockClient 透明重组，UI 看不到 frame。

## 状态归属

Host/Worker 提供的事实包括：

- instance lifecycle 与 generation；
- Agent run、conversation、tool 与 session event；
- Queue、operation 与 interaction；
- model、settings、resources 和 runtime state。

TUI 只拥有显示状态，例如 viewport、focus、搜索、折叠和未提交的 editor draft。TUI 不根据本地动画或 transport 状态改写 Host/Worker 事实。

## Conversation

Conversation 按 Agent 的真实 record kind、source、visibility 和 content structure 显示。首次进入或连续性丢失时，Work 清空旧 conversation，再按 `recentHistory + active page.events` 重建；当前 page 中尚未持久化的 Extension notification/error 也必须恢复，不能因 TUI 重连而丢失命令反馈。加载 earlier history 时只能沿同一次分页边界向前读取。保有本地画面且 cursor 连续的 reconnect 只追加 event replay/follow，不重建历史。

History record 和 live event 不做文本匹配或身份认领。在线的 completed component 直接留在本地画面；未来 fresh bootstrap 才用持久 record 替代它。Bootstrap 与加载期间的 event overlap 只按 `(runtimeGeneration, sequence)` 去重；内容相同的两个 turn 或 tool result 仍是两个事实。generation、Host epoch、ring continuity 或本地状态不一致时，必须 reset 后 bootstrap，不能混合两个边界补洞。历史分页也固定在 bootstrap 的 `historyRevision`；中途 checkpoint 改变 revision 时放弃该次 scan，不能将新旧 branch snapshot 拼接。

Thinking、tool call/result、custom message、image、attachment、bash、compaction/branch summary 和普通文本是不同内容结构。用户消息中的 attachment card 使用 Protocol V2 `AttachmentDto` 显示清洗后的名称、大小和可选 media type；TUI 不接收或推导 Host storage path。聊天图片附件同时产生 image block 与 attachment，image block 的 `fileId` 指向同一 DTO；两项协议事实都保留，TUI 作为客户端只渲染 attachment 行而不再增加重复的 image 占位。Queue、live event 和 fresh history bootstrap 使用同一 metadata，不把文件名拼进 prompt 文本来猜附件。Queue dequeue 恢复到 editor 时，Work 在本地 draft state 保留 opaque IDs，并在下一次提交继续使用 structured attachments；`/attachments` 可查看、`/attachments clear` 可明确移除，不能静默丢失或转写成普通 prompt 字符串。TUI 可以按 visibility 隐藏 record、折叠或做 preview，但不能修改底层语义；需要完整内容时继续通过 Protocol V2 获取。

## Extension UI

Extension component 在 Worker 运行。Work TUI 只实现 Dock 已定义的 interaction 或 custom surface：

- 显示 Worker 提供的内容或 frame；
- 把按键、viewport 和用户回答发回；
- 根据 Host 提供的当前操作者和会话状态恢复或关闭界面。

关闭窗口、重连或暂时不能操作不等于用户拒绝。新的操作入口接手时，旧 Work 仍继续显示实时更新和接受普通消息；等待中的 Extension UI 不会因此被取消。WebUI 是否实现同一 surface 与 Work TUI 无关。

## 视觉实现

Alu Dock 的主题、布局和组件由 `src/tui/` 内的实现负责。顶层架构文档不固定颜色值、控件细节或历史视觉纠偏；修改界面时以当前产品资产、实际终端效果和相关 TUI 代码为准。

## 代码范围

- `src/interactive.ts`：CLI 到 Hub/Work 的组合入口。
- `src/tui/dock-hub.ts`：Hub，以及本机 Settings/Devices 交互。
- `src/tui/workspace-browser.ts`：Dock New 目录列表、搜索、直接路径与大列表导航。
- `src/tui/dock-tui.ts`：Session Work composition 与输入。
- `src/tui/conversation.ts`：conversation rendering。
- `src/tui/snapshot-projection.ts`：Protocol event 到客户端本地 view state。
- `src/tui/session-tree*.ts`：Tree UI。
- `src/tui/extension-*.ts`：Extension UI surfaces。
- `src/tui/theme.ts`、`alu-palette.ts`：当前 TUI 主题实现。

新增 Agent 能力时，只有选择支持它的 TUI surface 需要变化。不要在 TUI 中复制 Host lifecycle、读取 Pi JSONL 或直接连接 Worker。
