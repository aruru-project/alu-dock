# Hub 与 Session Work TUI

## 这部分负责什么

Alu Dock 的 SSH 界面由两个客户端 surface 组成：

- **Hub**：创建、继续和管理 Dock instance；
- **Session Work**：连接一个 instance，与当前 Agent session 交互。

Hub 和 Work 的 Agent 工作能力都通过 DockClient 和 Protocol V2 使用 Host Service，不持有 Agent runtime，也不读取 Agent 私有 session 文件。只有 Hub 中的本机 service-management 页面例外：Remote Settings 与 Pairing 直接读写当前用户的私有 Host state，由 managed Host 观察并应用；它们不经过 DockClient，也不形成可供远程调用的管理协议。

```text
Hub / Work ───── Protocol V2 ──────── Host control/session gateway ── Worker
Hub Settings/Pairing ── local private state ── managed Host TLS ingress
```

## Hub

Hub 的主要对象是 Dock instance。它提供 New、Continue、History、persisted sessions、Settings、Pairing 和 Leave 等入口，但打开 Hub 本身不创建 runtime。

Settings 管理默认关闭的远程访问开关和端口，并显示 Host 是否已经开始监听。Pairing 默认关闭；用户必须在本机明确确认“Open Pairing Window”，才会在五分钟内显示此后到达的设备请求。一次只能把用户选中的一个设备推进到 PIN/证书证明；成功、证明失败、手动关闭、超时或 Host 重启都会关闭窗口并清除 provisional 请求。

Pairing 中用户选择设备、输入客户端显示的四位 PIN 并明确确认，也可以查看和吊销既有设备。列表项来自 Host 保存的短期 metadata，不对应等待中的 socket；客户端请求已经响应并关闭。主界面只显示窗口是否开放、设备名、时间、当前结果和下一步动作，不展示证书 fingerprint、pairing ID、SRP、内部 revision 或其他实现状态。已完成的设备信任持久保留，直到用户撤销。

Hub 使用 alternate screen；进入 Work 或离开前恢复 shell screen。Instance lifecycle 和 persisted-session inventory 来自 Host，不由 TUI 自己扫描 runtime。Hub 直接渲染 Protocol V2 的 `displayName`；缺少 session name/key 时的 cwd fallback 与安全清洗由 Host 统一完成，Hub 不再把短 instance ID 当作默认名称。

Hub 的 Dock New 从启动 `aludock` 时的当前目录打开 workspace 列表，经 `workspace.list.v1` 返回上级和子目录后再确认 cwd。列表支持搜索、分页/跳页、直接输入路径和隐藏目录切换；隐藏目录默认不显示，但直接输入隐藏路径仍可进入。目录符号链接带标记并按 Host 返回的规范目标继续浏览。取消选择返回 Hub，不创建半成品 instance；确认后才调用 `instance.create(cwd)`。直接执行 `aludock new --cwd ...` 的既有入口不经过 Hub 选择器。

## Session Work

Work 的主要对象是一个已打开的 Dock instance。它负责：

- conversation、thinking、tool、compaction 与 Agent activity 的显示；
- prompt、Queue、model、settings、session/tree 与 Extension UI 的交互；
- 读取当前视图、跟随实时更新，以及独立恢复 Extension UI 操作连接；
- editor、viewport、focus、搜索和本地 modal 状态。

Work 使用可流动的 main buffer 和终端原生 scrollback/selection。Detach 只断开客户端，不停止 Host 中的 instance。

## 状态归属

Host/Worker 提供的事实包括：

- instance lifecycle 与 generation；
- Agent run、conversation、tool 与 session event；
- Queue、operation 与 interaction；
- model、settings、resources 和 runtime state。

TUI 只拥有显示状态，例如 viewport、focus、搜索、折叠和未提交的 editor draft。TUI 不根据本地动画或 transport 状态改写 Host/Worker 事实。

## Conversation

Conversation 按 Agent 的真实 record kind、source、visibility 和 content structure 显示。首次进入或连续性丢失时，Work 清空旧 conversation，再按 `recentHistory + active page.events` 重建；加载 earlier history 时只能沿同一次分页边界向前读取。保有本地画面且 cursor 连续的 reconnect 只追加 event replay/follow，不重建历史。

History record 和 live event 不做文本匹配或身份认领。在线的 completed component 直接留在本地画面；未来 fresh bootstrap 才用持久 record 替代它。Bootstrap 与加载期间的 event overlap 只按 `(runtimeGeneration, sequence)` 去重；内容相同的两个 turn 或 tool result 仍是两个事实。generation、Host epoch、ring continuity 或本地状态不一致时，必须 reset 后 bootstrap，不能混合两个边界补洞。历史分页也固定在 bootstrap 的 `historyRevision`；中途 checkpoint 改变 revision 时放弃该次 scan，不能将新旧 branch snapshot 拼接。

Thinking、tool call/result、custom message、image、bash、compaction/branch summary 和普通文本是不同内容结构。TUI 可以按 visibility 隐藏 record、折叠或做 preview，但不能修改底层语义；需要完整内容时继续通过 Protocol V2 获取。

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
- `src/tui/dock-hub.ts`：Hub，以及本机 Settings/Pairing 交互。
- `src/tui/workspace-browser.ts`：Dock New 目录列表、搜索、直接路径与大列表导航。
- `src/tui/dock-tui.ts`：Session Work composition 与输入。
- `src/tui/conversation.ts`：conversation rendering。
- `src/tui/snapshot-projection.ts`：Protocol event 到客户端本地 view state。
- `src/tui/session-tree*.ts`：Tree UI。
- `src/tui/extension-*.ts`：Extension UI surfaces。
- `src/tui/theme.ts`、`alu-palette.ts`：当前 TUI 主题实现。

新增 Agent 能力时，只有选择支持它的 TUI surface 需要变化。不要在 TUI 中复制 Host lifecycle、读取 Pi JSONL 或直接连接 Worker。
