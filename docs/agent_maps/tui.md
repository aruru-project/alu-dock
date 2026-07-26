# Hub 与 Session Work TUI

## 这部分负责什么

Alu Dock 的 SSH 界面由两个客户端 surface 组成：

- **Hub**：创建、继续和管理 Dock instance；
- **Session Work**：连接一个 instance，与当前 Agent session 交互。

它们都通过 DockClient 和 Protocol V2 使用 Host Service，不持有 Agent runtime，也不读取 Agent 私有 session 文件。

```text
Hub TUI ──────── Protocol V2 ──────── Host control
Work TUI ─────── Protocol V2 ──────── Host session gateway ── Worker
```

## Hub

Hub 的主要对象是 Dock instance。它提供 New、Continue、History、persisted sessions 和 Leave 等入口，但打开 Hub 本身不创建 runtime。

Hub 使用 alternate screen；进入 Work 或离开前恢复 shell screen。Instance lifecycle 和 persisted-session inventory 来自 Host，不由 TUI 自己扫描 runtime。

## Session Work

Work 的主要对象是一个已 attach 的 Dock instance。它负责：

- conversation、thinking、tool、compaction 与 Agent activity 的显示；
- prompt、Queue、model、settings、session/tree 与 Extension UI 的交互；
- attach、event follow、cursor reconnect 与 controller lease；
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

Conversation 按 Agent 的真实角色和结构显示。History 分页、live event 和 reconnect 最终必须汇合成一份不重复、不缺失的当前会话视图。

Thinking、tool call/result、image、compaction 和普通文本是不同内容结构。TUI 可以折叠或做 preview，但不能修改底层语义；需要完整内容时继续通过 Protocol V2 获取。

## Extension UI

Extension component 在 Worker 运行。Work TUI 只实现 Dock 已定义的 interaction 或 custom surface：

- 显示 Worker 提供的内容或 frame；
- 把按键、viewport 和用户回答发回；
- 根据 Host controller/generation 状态恢复或关闭界面。

Detach、reconnect 或暂时没有 controller 不等于用户拒绝。WebUI 是否实现同一 surface 与 Work TUI 无关。

## 视觉实现

Alu Dock 的主题、布局和组件由 `src/tui/` 内的实现负责。顶层架构文档不固定颜色值、控件细节或历史视觉纠偏；修改界面时以当前产品资产、实际终端效果和相关 TUI 代码为准。

## 代码范围

- `src/interactive.ts`：CLI 到 Hub/Work 的组合入口。
- `src/tui/dock-hub.ts`：Hub。
- `src/tui/dock-tui.ts`：Session Work composition 与输入。
- `src/tui/conversation.ts`：conversation rendering。
- `src/tui/snapshot-projection.ts`：Protocol event 到客户端本地 view state。
- `src/tui/session-tree*.ts`：Tree UI。
- `src/tui/extension-*.ts`：Extension UI surfaces。
- `src/tui/theme.ts`、`alu-palette.ts`：当前 TUI 主题实现。

新增 Agent 能力时，只有选择支持它的 TUI surface 需要变化。不要在 TUI 中复制 Host lifecycle、读取 Pi JSONL 或直接连接 Worker。
