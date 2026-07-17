# Hub 与 Session Work TUI 图谱

## 适用范围

Interactive入口、Dock Hub、attached Session Work、conversation、history、tree、queue、settings、mouse、activity、terminal layout与视觉资产。

## 当前入口与数据流

```text
src/cli.ts open/new/attach
  └── src/interactive.ts: openDock()
        ├── ensureHost()
        ├── DockClient list/status/create/reopen
        ├── selectInstance()
        └── runDockTui(client, instance)

runDockTui()
  ├── initial closed queries: attach/history/settings/tools/resources/commands
  ├── FixedDockScreen + conversation/editor/chrome
  ├── streamEvents()
  │     ├── snapshot-projection reducer
  │     ├── DockConversation
  │     └── run-activity reducer
  └── editor/slash/key input ──> DockClient mutations
```

当前没有独立Hub组件；`openDock()`仍会选择或创建runtime。实现bare-command Hub时，在`interactive.ts`旁建立focused Hub composition，不要把managed-instance列表和Resume/Adopt inventory塞进attached `dock-tui.ts`。

## Scope边界

```text
Dock Hub
  primary object: Dock instance
  actions: managed instance lifecycle/navigation
  separate inventory: persisted Pi sessions for Resume/Adopt
  mascot: client-local, low-frequency blink only; no Host/instance aggregation

Session Work TUI
  primary object: one attached Dock instance + current Pi session
  session commands may replace current Pi session and roll generation
  mascot/activity: only current session's known activity
```

## 文件owner

| 文件 | 唯一职责 | 主要测试 |
|---|---|---|
| `src/interactive.ts` | TTY entry composition、当前instance resolution/Work routing、trust prompt；也是Hub routing入口 | CLI/managed/PTY tests |
| `src/tui/dock-tui.ts` | attached Work workflow composition、commands、focus/key actions | `tui-ux-state`, PTY fixture |
| `src/tui/conversation.ts` | durable conversation rows、tool folding/rendering、status/activity line投影 | `tui-conversation` |
| `src/tui/snapshot-projection.ts` | DockEvent → local InstanceSnapshot reducer | `tui-ux-state` |
| `src/tui/run-activity.ts` | current-session transient activity reducer | `tui-ux-state` |
| `src/tui/activity-pulse.ts` | fixed localized animation writer；idle无timer | `tui-ux-state` |
| `src/tui/pi-tui-screen.ts` | fixed screen section composition与history anchor | `tui-ux-state` |
| `src/tui/screen-layout.ts` | viewport math、fixed chrome、resize composition | `tui-ux-state` |
| `src/tui/history-pagination.ts` | bounded history window、earlier-page cursor、anchor preservation | `history-pagination` |
| `src/tui/pending-queue.ts` | pending queue tray projection | `tui-ux-state` |
| `src/tui/queue-restoration.ts` | dequeue text prepend且不覆盖concurrent draft | `queue-restoration` |
| `src/tui/session-tree.ts` | tree pagination/filter/picker command parsing | `session-tree` |
| `src/tui/settings-controls.ts` | setting choices、command values、completion | `tui-ux-state` |
| `src/tui/extension-text-dialog.ts` | bounded extension select/confirm/input/editor UI | extension UI/TUI tests |
| `src/tui/searchable-picker.ts`, `search-filter.ts` | reusable picker与deterministic filtering | `tui-ux-state` |
| `src/tui/mouse-input.ts` | explicit Dock mouse mode、wheel decoding、terminal mode cleanup | `tui-ux-state`, PTY |
| `src/tui/select-instance.ts` | legacy/pre-Hub instance chooser | managed/PTY tests |
| `src/tui/theme.ts` | terminal color capability与Night Console palette | render/PTY checks |

## 人类事实分类

| 类别 | 去向 | 示例 |
|---|---|---|
| Durable conversation | `DockConversation` | user/assistant/tool result、session-changing outcome |
| Transient status/activity | activity/status fixed slot | submitting、model streaming、tool running、aborting |
| Interaction | focused dialog/editor | Extension UI select/confirm/input/editor |
| Explicit diagnostics | requested diagnostic surface或actionable warning | Host unavailable、setting persistence failure |
| Internal bookkeeping | 不渲染 | replay bounds、cursor revision、operation ledger、expected pagination state |

Warning必须说明用户影响和可执行动作；closed Host projection本身不等于conversation展示许可。

## 常见修改路由

| 需求 | 从这里开始 | 随后检查 |
|---|---|---|
| bare Hub / instance list / Resume inventory | `interactive.ts` + 新focused Hub模块 | `cli.ts`, `cli-list.ts`, DockClient queries、80×24/120×40 PTY |
| Work信息层级或multiline | `conversation.ts`, `screen-layout.ts` | `pi-tui-screen.ts`, `dock-tui.ts`, render tests |
| transient activity | `run-activity.ts`, `activity-pulse.ts` | snapshot reducer、fixed activity slot、idle CPU |
| conversation event展示 | `conversation.ts` | event lifetime分类、history replay dedup |
| history paging/scroll/resize | `history-pagination.ts`, `screen-layout.ts` | anchor、mouse wheel、PTY resize |
| `/tree` picker与返回branch | `tui/session-tree.ts`, `dock-tui.ts` | Core/runtime tree map、real Pi tree tests |
| queue tray/restoration | `pending-queue.ts`, `queue-restoration.ts` | command admission、draft concurrency |
| mouse mode | `mouse-input.ts` | detach/signal/error cleanup、normal terminal selection |
| Logo/mascot | 新focused visual component + `theme.ts` | Hub blink无语义；Work只由current session activity驱动 |
| command completion/settings | `dock-tui.ts`, `settings-controls.ts` | command catalog、terminal sanitization |

## 交互硬约束

- 普通drag/selection属于terminal；只有显式Alt+M或`/mouse`启用1000/1006 tracking。
- detach、stop、signal和异常退出都恢复terminal mode。
- Work TUI不持有Pi对象，不读取session JSONL；只通过DockClient和closed DTO/event。
- Queue是Same-Host memory；in-flight/failed/ambiguous mutation不声称已restore，也不自动abort。
- Exact extension command不进入pending queue；unknown slash保留Pi-native语义。
- Extension UI只支持bounded closed text；不transport component factory、image、binary或data URI。
- 动画只写固定surface；idle无timer。Hub最多一个visible时才运行的低频本地blink timer。
- Renderer替换必须一次性cut over，不维护dual renderer或compatibility facade。

## 人工输出门禁

提交人类可见surface前，必须亲看：

- 80×24：最小SSH窗口、长cwd/name、multiline input、tool output、dialog；
- 120×40：正常层级、history宽度、fixed chrome、tree/picker；
- resize、detach、signal、mouse mode cleanup；
- 无颜色与ANSI 16/256能力下仍可读。

## 默认不读

- Pi SDK internals；若TUI需要新数据，先定义closed Core/Protocol projection。
- deployment代码与Git历史中的验证证据。
- `dist/`与历史视觉mockup。
