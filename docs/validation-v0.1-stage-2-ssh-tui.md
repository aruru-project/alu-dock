# V0.1 阶段 2：SSH TUI 核心与 Footer 验证

日期：2026-07-14

## 结论

阶段 2 实现范围已完成：Host advertised `tui.projection.v1` 与独立的 `run.abort.v1`；SSH client 仍是只消费 closed DTO/event 的薄 TUI，不加载或持有 `AgentSession`。

## 实现面

- `pi-tui` `Editor`：history、multiline paste、Dock + extension/skill/prompt command autocomplete、path autocomplete；model/thinking 参数补全。
- `Markdown`/code/thinking 呈现；thinking 遵循 Pi `hideThinking` 设置。
- generic tool renderer：stable call ID、streaming args update、output update、result/error、diff、`Ctrl+O` 展开/折叠。
- persisted branch history：只使用公开 `AgentSession.sessionManager.getBranch()`；`session.history` 按 stable entry ID 反向分页，attach 带不与 event ring 重叠的 history baseline。
- retry、compaction、queue、error、replacement 和 Host transport loss状态。
- Footer：cwd、Dock/Pi ID、model/thinking、execution/queue、tokens/context/cache/cost、extension status、connection/lease。
- input/lifecycle：`Enter` send/steer、`Alt+Enter` follow-up、`Esc`/空编辑器 `Ctrl+C` abort、`Ctrl+D` detach；abort 后实例保持可复用。
- Pi compaction 使用公开 `abortCompaction()` 并等待 idle；不会把 compaction cancellation伪造为 `lastRun=aborted`。
- replacement stream按 `(runtimeGeneration, sequence)` 排序；新 generation sequence 1 不会被旧 generation 高 sequence丢弃。
- settings live apply：editor/output padding、autocomplete max、hardware cursor、clear-on-shrink、terminal progress、auto-compaction footer状态。
- binary/image/base64、function、handler、runtime object 均不进入 TUI projection；`show_image` 只保留普通文本 path/omission。

## 确定性门禁

- conversation/history/live-event projection覆盖 Markdown、thinking、tool/diff、retry、queue、compaction、replacement、Host loss。
- footer cache hit固定为 `cacheRead/(input+cacheRead+cacheWrite)`；metrics closed parser要求非负 finite/safe integer和 `0..100|null` context percent。
- assistant message ID在同一消息的 delta/completion之间稳定，不同消息不复用；toolcall start/delta/execution共享 stable tool call ID。
- attach 在 response 前注册 listener，response 后按 generation/sequence flush；真实 `DockHost` rollover regression覆盖 generation 2/sequence 1。
- history、snapshot、event ring从 committed projection读取；stop-intent commit阻塞期间 read-only attach仍返回旧 committed facts。
- command/model autocomplete value经过 terminal-control sanitization，command projection拒绝 C0/C1 control name。

## PTY 门禁

`test/fixtures/pty-tui-driver.py` 使用真实 PTY：

1. 80x24 启动并重放，再 `SIGWINCH` 调整为 43x18；
2. bracketed multiline paste、提交、history-up重提；
3. `Ctrl+C` abort 后验证 active + idle、runtime 未 dispose；
4. `Ctrl+D` detach 后验证 instance仍由 Host持有；
5. Host transport close 后显示 read-only/no-replay，再允许 detach。

## Reviewer findings closed

首轮 reviewer 的六项 finding 均已修复并增加 regression：

- Host replacement generation rollover；
- compaction-aware abort；
- tool args updates 与 stable assistant IDs；
- replacement 后 Footer cwd/Pi ID；
- autocomplete terminal injection；
- `command.abort` 独立 capability。

## 最终门禁

```bash
npm run check -- --pretty false
npm test
npm audit --audit-level=high
git diff --check
```

结果：

- TypeScript：PASS。
- clean build + tests：**135/135 PASS**。
- `npm audit --audit-level=high`：0 vulnerabilities。
- `git diff --check`：PASS。
- package-root export：PASS；Pi private subpath import：0。
- SSH TUI client `AgentSession/createAgentSession` import：0。
- 真实 Pi `0.80.6` no-model-call smoke：metrics messages/tokens/cost/context projection可读，`contextWindow=372000`，public SessionManager history可分页，explicit stop成功。
- Reviewer首轮 6 项、复核 2 项与 chronology recheck 均已关闭；最终结论：**CLEAN**。

## 明确延期

- `/settings`、`/tools`、new/resume/name/compact/reload：阶段 3。
- controller interaction broker与 extension UI：阶段 4。
- `systemd --user`、durable atomic catalog、startup reconcile、explicit reopen：阶段 5。
- tree/fork/clone：阶段 6。
- Dock 不提供 image paste、inline image、artifact endpoint或 binary transport。
