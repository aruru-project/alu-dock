# V0.1 Stage 6：Tree / Fork / Clone 验证

日期：2026-07-15

卡片：#142

状态：**源码与自动化门禁 PASS；等待从 clean committed HEAD执行 immutable managed rollout。**

基线：`@earendil-works/pi-coding-agent@0.80.6`、`@earendil-works/pi-tui@0.80.6`、Protocol V2 only。

## 1. 范围与结论

Stage 6 完成 `session.tree.v1`，同时保持 Stage 4 extension lifecycle、Stage 5 durable catalog/reopen/no-replay 与 controller lease 不变量：

- `session.tree`：Host-owned closed tree DTO、generation-bound revision、每页最多 200项；
- `session.navigate`：同一个 Pi session file内导航，可选Pi原生branch summary；
- `session.fork`：只允许user-message target，固定公开调用`fork(entryId,{position:"before"})`；
- `session.clone`：只允许current leaf，公开组合`fork(leafId,{position:"at"})`；
- `/tree`、`/fork`、`/clone`：searchable selector、Dock-owned filter/pagination与editor restoration；
- summary、replacement、detach、Host drain仍fail closed，不构造第二套slash-command executor。

结论：**PASS**。Tree navigation不换Pi session file；fork/clone生成新Pi session和runtime generation；全路径没有模型调用或旧prompt replay。

## 2. 实现边界

### 2.1 Closed tree projection

`src/core/session-tree.ts`拥有Pi无关的tree validation/projection：

- 接受稳定depth-first pre-order，拒绝重复ID、非法parent/depth/child关系；
- runtime上限100000 entries；wire page上限200；TUI selector收集上限5000；
- revision为`g<runtimeGeneration>-<sha256>`，覆盖leaf、结构、label及label timestamp；
- node kind/role、ID、timestamp和文本均使用closed schema与bounded projection；
- C0/C1被过滤，data URI、raw/embedded base64使用omission文本，binary/image不进入wire；
- continuation必须同时提供revision与`afterEntryId`；stale/foreign cursor fail closed。

`src/tui/session-tree.ts`只拥有client行为：固定revision分页、变化检测、filter、picker rows与direct command parsing，不依赖`DockClient`或Pi runtime。

### 2.2 Public Pi API

`src/pi/pi-runtime-host.ts`只使用包根公开API：

- `AgentSession.sessionManager.getTree()/getLeafId()/getEntry()`；
- `AgentSession.navigateTree()`与`abortBranchSummary()`；
- `AgentSessionRuntime.fork(entryId,{position:"before"|"at"})`。

没有使用内部`clone()`、private subpath或stock `InteractiveMode`。Fork-before若Pi成功后没有返回`selectedText`，adapter单调进入replacement failure，而不是伪造空editor。

### 2.3 Navigation 与 abort

Navigation占用独立configuration gate，和prompt/settings/replacement互斥。普通navigate只在post-effect catalog commit后发布`session.navigated`；TUI收到事件后重新加载当前branch history。

Branch summary进行中，Esc/Ctrl+C及`command.abort`进入Pi adapter的`abortBranchSummary()`，等待原navigation Promise完成；不会把tree cancellation伪装成agent `run.settled`，也不会改变`lastRun=never`。Extension `session_before_tree`取消时不发布navigation event。

### 2.4 Fork/clone replacement 与 durable recovery

Fork/clone沿用Stage 5 transaction：

1. target validation；
2. durable replacement intent（operation ID、kind、previous durable file、requested entry）；
3. Pi extension before hook；
4. teardown/factory/bind；
5. target catalog commit；
6. generation rollover、new stream/new controller lease与`session.replaced`发布。

Pre-effect catalog失败不调用Pi；post-effect commit失败返回operation-scoped`effect_unknown`并触发mutation-fault drain。Extension cancel清除intent且不换generation。Factory/bind failure只允许previous durable session作为explicit reopen recovery。

Pi 0.80.6在fork-before-first-user时可能返回未来JSONL path但尚未创建文件。Dock将runtime identity与durable catalog path分开：candidate尚未成为current-user-owned real non-symlink file时，catalog省略`sessionFile`并暂存previous durable file为`recoverySessionFile`；后续catalog commit确认文件后才提升candidate path。该窗口Host loss不会打开不存在的文件，也不会恢复selected prompt。

## 3. 自动化证据

最终合并门禁命令：

```bash
npm run check -- --pretty false
npm test
npm audit --audit-level=high
git diff --check
```

结果：

- TypeScript：PASS；
- clean build：PASS（`npm test`先删除并重建`dist`）；
- Node tests：**208/208 PASS**；
- npm audit：**0 vulnerabilities**；
- diff whitespace：PASS；
- Pi package-root runtime exports：PASS；
- `src/test/scripts`无`@earendil-works/pi-coding-agent/*` private import：PASS；
- `src/tui`无`AgentSession`/`createAgentSession` runtime import：PASS；
- stock `InteractiveMode` gate：PASS；
- `.pi/settings.json`：未修改。

### 3.1 Real Pi、hooks与no-model

`test/pi-tree-real.test.ts`使用真实Pi 0.80.6 runtime和fixture JSONL验证：

- revision分页与stale revision；
- in-file navigate不换file/generation；
- fork-before生成parent session并返回原user text；
- clone-at-current-leaf生成下一parent session；
- deferred candidate file与durable recovery；
- 全程无`run.started`，`lastRun=never`，tokens/cost均为0。

`test/pi-tree-hooks-real.test.ts`加载真实临时extension并验证：

- `session_before_tree`/`session_tree`；
- `session_before_fork`的`before`与`at`；
- extension cancel保持file/generation；
- branch-summary abort signal确实到达extension；
- successful fork触发`session_shutdown(reason=fork)`与`session_start(reason=fork)`。

### 3.2 Protocol、catalog与failure seams

覆盖项包括：

- request/result/event closed parser、payload过滤、tree cursor bounds；
- operation-ledger dedup与operation-ID conflict；
- target kind/current-leaf validation；
- navigation post-effect ambiguity不发布未提交event；
- fork/clone intent schema、startup reconcile与deferred recovery round-trip；
- replacement cancel、factory/bind error、target catalog failure、runtime-error catalog failure；
- generation reset、retired binding隔离、controller reacquire。

### 3.3 Real PTY

`test/dock-control.test.ts`通过真实PTY driver执行：

1. `/tree tree-user`；
2. `/fork tree-user`；
3. 检查selected prompt回到composer；
4. `/clone`；
5. 检查generation变化并正常detach。

同一测试套件继续覆盖fixed composer、viewport、picker、extension dialogs、replacement stream与transport-loss no-replay。

## 4. 偏差

- Wire `session.fork`不接受`position`；V0.1产品合同固定fork-before，clone使用独立request，避免客户端改变语义。
- Tree selector为本地最多5000 entries的bounded view；Host仍允许100000-entry closed projection和revision pagination。超过selector cap会明确提示，不静默声称完整。
- 没有调用真实模型完成successful branch summary；自动化以真实Pi extension cancellation/abort seam证明取消语义，避免为门禁制造模型side effect。

以上均为显式安全边界，不是未处理兼容层。

## 5. 剩余验收与部署

自动化不能替代：

- 长会话中的真人tree可读性与branch summary质量；
- 真实provider/network下successful summary；
- 多小时SSH resize/scroll/composer体验；
- Stage 6 managed release后的默认`alu-dock`真人验收。

Managed rollout必须从clean committed HEAD创建新immutable release，原子切换`current`，验证新`MainPID`/`hostEpoch`、`session.tree.v1` hello、真实installed-resource tree smoke与rollback。部署完成前，当前在线service仍是Stage 5 baseline。
