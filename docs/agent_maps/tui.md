# Hub 与 Session Work TUI 图谱

## 适用范围

Interactive入口、Dock Hub、attached Session Work、conversation、history、tree、queue、settings、mouse、activity、terminal layout与视觉资产。

## 当前入口与数据流

```text
src/cli.ts bare Hub / -c / open / new / attach
  └── src/interactive.ts: openDock()
        ├── ensureHost()
        ├── bare → runDockHub(client, cwd)
        │          ├── instance catalog
        │          └── persisted Pi session inventory
        ├── explicit open/new/attach → target/create/reopen
        └── selected action → runDockTui(client, instance)

runDockTui()
  ├── initial closed queries: attach/history/settings/tools/resources/commands
  ├── flowing Container: conversation → activity/queue → editor → three-row footer
  ├── streamEvents()
  │     ├── snapshot-projection reducer
  │     ├── DockConversation
  │     └── run-activity reducer
  └── editor/slash/key input ──> DockClient mutations
```

当前独立 Hub 由 `src/tui/dock-hub.ts` 负责，固定根菜单顺序是 New、Continue、History、Pi Sessions、Leave。首屏只读取 Dock catalog；Continue 再展示 active/reopenable 工作，History 再展示 stopped 与不可恢复的 terminal records，全局 Resume/Adopt inventory 在用户进入 Pi Sessions 后延迟加载。History Continue 从原 Pi session 创建新 Dock identity，Forget 只删 History record。Work `/resume` 不创建 Dock identity，只切换当前 instance 的 Pi session；它的 picker 必须使用 `cwd` scope，只展示当前 Work 项目的 Pi sessions，跨项目恢复留在 Hub。`-c`/`--continue` 是显式 current-project smart-entry。Hub 以一次 alternate-screen 生命周期和响应式大阿露/窄印章呈现所有菜单，菜单可见时独占 xterm 1000/1006 click/wheel，离开或转入 Work 前先关闭 tracking 并恢复 shell screen；唯一低频眨眼 timer 也只在 menu 可见时存在。Work 小阿露复用 current-session activity pulse，idle 不启动 timer；Work 始终使用可流动 main buffer 与 terminal-native mouse。

## Scope边界

```text
Dock Hub
  primary object: Dock instance
  root: New / Continue / History / Pi Sessions / Leave
  current work: active/reopenable managed instance lifecycle
  history: stopped/unrecoverable Dock records; stopped saved sessions may Continue, all may Forget
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
| `src/interactive.ts` | TTY entry composition、Hub action/Work routing、human target lifecycle、trust prompt | CLI/managed/PTY tests |
| `src/tui/dock-hub.ts` | Dock instances主列表、lifecycle actions、独立Pi session Resume/Adopt inventory、visible-only Hub blink ownership | `human-target`, `dock-control` PTY |
| `src/tui/dock-tui.ts` | attached Work flowing composition、commands、focus/key actions、replacement reconciliation | `tui-ux-state`, PTY fixture |
| `src/tui/conversation.ts` | complete flowing branch conversation、UI-only extension notify rows、hard/soft multiline tool rendering | `tui-conversation` |
| `src/tui/snapshot-projection.ts` | DockEvent → local InstanceSnapshot reducer | `tui-ux-state` |
| `src/tui/run-activity.ts` | authoritative runtime/model/boundary current-session activity reducer | `tui-ux-state` |
| `src/tui/activity-pulse.ts` | frame-cached activity animation scheduler；idle无timer | `tui-ux-state` |
| `src/tui/history-pagination.ts` | eager reverse-page drain、overlap dedup、history/live exact reconciliation | `history-pagination` |
| `src/tui/pending-queue.ts` | pending queue tray projection | `tui-ux-state` |
| `src/tui/queue-restoration.ts` | dequeue text prepend且不覆盖concurrent draft | `queue-restoration` |
| `src/tui/session-tree.ts` | tree pagination/filter、branch topology/active path picker、command parsing | `session-tree` |
| `src/tui/settings-controls.ts` | setting choices、command values、completion | `tui-ux-state` |
| `src/tui/extension-text-dialog.ts` | bounded extension select/confirm/input/editor UI | extension UI/TUI tests |
| `src/tui/searchable-picker.ts`, `search-filter.ts` | reusable picker与deterministic filtering | `tui-ux-state` |
| `src/tui/mouse-input.ts` | Hub-only bounded click/wheel decoding、paired tracking sequences | Hub parser/layout、PTY |
| `src/tui/select-instance.ts` | 仅供显式旧 `open` smart-entry 的legacy chooser | managed/PTY tests |
| `src/tui/alu-palette.ts` | canonical Alu palette（mascot与Work theme共同唯一来源） | render/ANSI/NO_COLOR checks |
| `src/tui/theme.ts` | terminal color capability与palette-derived semantic paint | render/PTY checks |
| `src/tui/alu-mascot.ts` | 大/小阿露静态帧、TrueColor/ANSI/NO_COLOR安全投影 | `alu-mascot`, PTY |

## 人类事实分类

| 类别 | 去向 | 示例 |
|---|---|---|
| Durable conversation | `DockConversation` | user/assistant/tool result、session-changing outcome |
| Runtime activity | 小阿露fixed activity slot | submitting admission、model waiting/thinking/responding、compaction/retry/interaction/aborting；queue/tool/local feedback不得写入 |
| Extension notify feedback | `DockConversation`的UI-only rows | 连续tail `info`原位替换；有可见内容介入后新建；`warning/error`逐条追加；不写Pi session history |
| Persistent extension status | reserved extension footer row | `setStatus(key,text)`同key替换、不同key并存、`undefined`删除 |
| Interaction | focused dialog/editor | Extension UI select/confirm/input/editor |
| Explicit diagnostics | requested diagnostic surface或actionable warning | Host unavailable、setting persistence failure |
| Internal bookkeeping | 不渲染 | replay bounds、cursor revision、operation ledger、expected pagination state |

Warning必须说明用户影响和可执行动作；closed Host projection本身不等于conversation展示许可。

## Alu 视觉主题硬约束

- `src/tui/alu-palette.ts` 是 mascot 与 Work 共享的唯一 canonical palette：`#69424e`、`#976269`、`#f6c147`、`#f4d8ce`、`#6c84cd`、`#dd7e9e`、`#e6e1f2`。原稿与产品决定见 card #202；蓝色只允许偏紫/偏靛方向。
- 禁止把 cyan、teal、turquoise、emerald、青绿或霓虹科技蓝作为 accent、success、selection 或默认交互色；不得以常见 dark-dashboard/Tailwind 风格代替阿露身份。成功状态优先由 `✓`、文案和结构表达。
- `theme.ts` 只能复用或从 canonical palette 派生前景、局部 surface 与降级色；不得自行维护第二套品牌色。终端背景由用户拥有，不做全屏背景接管。
- 对齐 stock Pi 的对象是 conversation 的角色层级、分组、间距、内容优先与展开/折叠语义，不是 Pi 的颜色。User message 使用Pi式全宽Box、`outputPad`横向padding、上下各一行padding与Markdown行内语义，但局部背景只用canonical pink派生的低亮暖粉。compaction、thinking、assistant、tool invocation/result 必须一眼可区分；默认tool是有界call/result preview而非“图标 + done + 一行摘要 + 快捷键”的遥测日志。Built-in truncation/limit/continuation/full-output notices使用canonical gold warning，diff删除使用暖粉error、增加使用暖白success，全部嵌在palette-derived tool surface中。Ctrl+O仍是Host-authoritative全局details（不得声称Host已裁切内容是“full”），Alt+O仍是本地detail folding。
- 新增颜色、改变品牌主次关系或采用新的全局视觉风格前，必须先取得用户明确确认；80×24、120×40、ANSI 16/256、TrueColor 与 `NO_COLOR` 都要保持同一语义层级。

## 常见修改路由

| 需求 | 从这里开始 | 随后检查 |
|---|---|---|
| bare Hub / Continue / History / Resume inventory / `-c` | `interactive.ts` + `dock-hub.ts` | `cli.ts`, `cli-list.ts`, DockClient queries、80×24/120×40 PTY |
| Work信息层级或multiline | `conversation.ts`, `dock-tui.ts` | flowing component order、footer rows、render tests |
| transient activity | `run-activity.ts`, `activity-pulse.ts` | snapshot reducer、activity slot、idle CPU |
| conversation event展示 | `conversation.ts` | event lifetime分类、history replay dedup |
| history加载/scroll/resize | `history-pagination.ts`, `dock-tui.ts` | eager drain、live boundary、native scrollback、PTY resize |
| `/tree` picker与返回branch | `tui/session-tree.ts`, `session-tree-surface.ts`, `dock-tui.ts` | `work-modal.ts`、Core/runtime tree map、real Pi tree tests |
| queue tray/restoration | `pending-queue.ts`, `queue-restoration.ts` | command admission、draft concurrency |
| Hub mouse / fullscreen | `dock-hub.ts`, `mouse-input.ts` | Leave/Work/signal/error cleanup ordering、click/wheel hitbox、resize |
| Logo/mascot | `alu-mascot.ts` + `dock-hub.ts` | Hub blink无语义；Work只由current session activity驱动 |
| command completion/settings | `dock-tui.ts`, `settings-controls.ts` | command catalog、terminal sanitization |

## 交互硬约束

- Hub 独占一次 alternate screen 生命周期；只有可见 Hub menu 启用成对的1000/1006 tracking，滚轮每次只移动一个选项，左键只激活真实可见item。Leave、转入Work、signal与异常路径必须先关闭tracking再恢复main screen。
- Session Work 始终使用可流动的main buffer与terminal-native drag/selection/scrollback，不启用1000/1006或alternate screen，也没有Alt+M、`/mouse`模式；Work导航不得用清空terminal scrollback的force redraw。共享Pi setting中的`clearOnShrink`不改变这个合同：Work client始终将pi-tui clear-on-shrink关闭，普通render不得输出`ESC[3J`。
- detach、stop、signal和异常退出都恢复terminal mode；Ctrl+D 是不等待长 Host mutation 的本地最高优先级 detach。
- Work overlay 统一使用有边界的 modal frame 与栈式焦点恢复；picker/text/editor child在每次render时从当前terminal rows取得完整内容预算，resize后立即重算，先保留selection/footer再裁切body/input viewport。80×24时80% overlay最多19行（17 child rows + 2 frame rows）。固定动作不用 searchable picker。Tree 当前selection使用canonical indigo全行背景与醒目的金色实心游标，`NO_COLOR`下仍保留实心游标，不能只依赖细小箭头；Branch action 保持原 Tree surface 挂载，Esc 返回时保留 filter/search/fold/selection。
- Work TUI不持有Pi对象，不读取session JSONL，也不从client shell轮询Git；只通过DockClient和closed DTO/event。Footer workspace context使用Host协商的`git.branch-footer.v1`投影：repository显示`cwd (branch)`、detached HEAD显示`cwd (detached)`、非repository只显示cwd。Fresh attach 的对话真相是当前 branch history，不把旧 lifecycle/navigation replay 投影为 conversation；无command ID的`runtime-initiated` active run仍恢复未完成tool/message tail。`display:false` custom control message永不成为conversation。
- 当前branch effective history必须在进入Work时跨内部200-entry页完整drain，paging只属于传输获取，UI不暴露page/anchor/paused状态。`DockConversation`按stock Pi方式作为flowing chat container进入terminal scrollback；历史、coherent attach bootstrap与加载期间live events按内容/cursor去重且恰好投影一次。默认tool preview按视觉行有界并明确标出本地隐藏内容；`bash`按tail显示，`read/write/grep/find/ls`按head显示，typed warning固定留在preview之外而不被行预算折掉。成功的built-in `edit`使用Pi result details中的display-oriented、带行号增删diff，而不是只显示`Successfully replaced...`；失败仍显示authoritative error。所有built-in presentation必须live/reattach一致；running/update/completion等自动生命周期更新在同一width下不得缩短已显示tool surface，避免editor/footer上浮。长历史、expanded tools与多次compaction仍须保持composer/footer响应。进入带背景的tool/compaction surface前必须把水平tab按终端tab stop展开成真实空格；光标跳转不能在整行surface中露出用户终端原生背景。
- Queue是instance/generation-scoped的Same-Host memory；in-flight/failed/ambiguous mutation不声称已restore，也不自动abort。Compaction期间Host-deferred消息必须在detach/attach后继续显示，且不得与另一个instance串线。Queue与active run正交，pending内容只进入composer邻近tray/conversation tail，不得抢占固定Activity中的model phase。
- Editor提交后若收到definite rejection或`effect_unknown`，必须把原delivery intent与文本prepend回当前draft，不覆盖等待期间的新输入；ambiguous outcome要显示原operation ID与“先核对再手动重发”，但绝不自动retry。
- Exact extension command不进入pending queue；unknown slash保留Pi-native语义。
- Extension UI只支持bounded closed text；不transport component factory、image、binary或data URI。Host若截断tool output必须附明确truncation marker；modal或config/session inventory不完整时，Work/Hub显示shown/total或首条scan diagnostic，不能把bounded prefix呈现为完整结果。
- Extension `notify`与`setStatus`不可混用：notify遵循Pi的chat-tail语义，连续tail info才替换，warning/error逐条追加；setStatus属于keyed footer state。两者都不得覆盖小阿露runtime activity。
- 固定Activity对齐stock Pi的top-level working状态机，唯一owner是authoritative runtime phase。Editor draft、queued follow-up、tool/bash start/update/end、picker/config/local command反馈都与active model run正交，不得覆盖`waiting for model`、`thinking`或`responding`；tool细节属于conversation surface，queue属于pending tray。局部操作结果使用modal或Pi式chat-tail status反馈。
- Activity优先级必须由明确boundary决定：disconnect/error/stopped > compaction/abort/retry/interaction > active model run > idle。临时phase结束后从最新snapshot/event重新投影，不恢复陈旧本地label；`ready`只来自authoritative settlement或idle snapshot。
- `submitting`是回车后等待Host admission的client-local状态：逻辑上立即生效，但只有持续未决200ms后才显示；快速no-run command不得闪烁，已有active run上的新prompt即使进入queue也保持原model phase，`waiting for model`只由真实run start或authoritative running snapshot触发。
- Runtime activity按仍在进行的较新boundary投影：fresh attach从closed snapshot `compacting`恢复active compaction；`compaction.started`之后到达的旧run `run.settled`不得覆盖`compacting context`；`compaction.completed`结束该phase，后续continuation必须由真实`run.started`进入waiting。
- Work所有动画都通过pi-tui frame cache请求正常render；禁止cache外绝对行写入。idle无timer。Hub最多一个visible时才运行的低频本地blink timer。
- Renderer替换必须一次性cut over，不维护dual renderer或compatibility facade。

## 人工输出门禁

提交人类可见surface前，必须亲看：

- 80×24：最小SSH窗口、长cwd/name、multiline input、tool output、dialog；
- 120×40：正常层级、flowing history宽度、三行footer、tree/picker；
- resize、detach、signal、Hub mouse/alternate-screen cleanup与Work main-buffer隔离；
- 无颜色与ANSI 16/256能力下仍可读。

## 默认不读

- Pi SDK internals；若TUI需要新数据，先定义closed Core/Protocol projection。
- deployment代码与Git历史中的验证证据。
- `dist/`与历史视觉mockup。
