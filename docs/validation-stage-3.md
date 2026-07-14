# 阶段 3 验证记录：跨客户端继续交互与显式停止

日期：2026-07-14  
Pi SDK：0.80.6  
Node：22.21.0

## 结论

**PASS。第二客户端已能控制同一宿主持有的实例，而不只是观察。**

已证明：

- 空闲实例接受新 prompt 时返回 `delivery=prompt, queued=false`，receipt 不等待完整运行。
- 运行中 `auto` 明确解析为 steer；显式 follow-up 返回 queued receipt。
- 不合法 delivery、stopped 实例和不存在实例均返回结构化错误。
- stop 会清空 queue、abort 当前运行并 dispose；首次与重复 stop 的 receipt 可区分。
- `lastRun=aborted`、`lifecycle=stopped` 和 command acceptance 是不同结构化事实。
- host SIGINT/SIGTERM 正常调用 `stopAll`；若正常清理超过 10 秒，前台 host 进程以 `shutdown_timeout` 非零终止，不建设故障恢复层。

## 实现范围

- JSONL v1 新增 `prompt`、`stop` request 与严格 result validation。
- `DockClient.prompt()` / `DockClient.stop()`。
- CLI：
  - `prompt INSTANCE_ID [--delivery auto|prompt|steer|followUp] MESSAGE`
  - `stop INSTANCE_ID`
- Host 将领域错误映射为：`not_found`、`instance_not_active`、`invalid_delivery`、`admission_pending`。
- Prompt result 同时包含 accepted `CommandReceipt` 与当前 snapshot；Stop result 包含 `StopReceipt` 与最终 snapshot。

## 自动验证

```text
$ npm run check
exit 0

$ npm test
exit 0
29 tests passed, 0 failed
```

阶段 3 新覆盖：

1. Client A 退出后，Client B 对空闲实例启动新 prompt；Client C 看到同一实例仍 running；
2. 运行中 auto→steer，显式 follow-up，两者 receipt 均 `queued=true`；
3. fake runtime queue_update 投影 steering/follow-up 数量；
4. 运行中显式 prompt 得到 `invalid_delivery`；
5. stop 清队列并 abort，snapshot 为 `lastRun=aborted/lifecycle=stopped/pending=0`；
6. 第二次 stop 返回 `alreadyStopped=true`；
7. stopped 后 prompt 返回 `instance_not_active`；
8. 独立 CLI 子进程依次完成 fresh prompt、steer、stop 和重复 stop；
9. protocol 拒绝未知 delivery。

## 真实 Pi SDK stop smoke（无模型调用）

独立 host/client 进程创建真实 Pi SDK instance 后执行两次 stop，再尝试 prompt：

- evidence directory：`/tmp/alu-dock-stage3-real-Tjz8xV`
- Dock instance：`cd7f5c57-3e24-4804-b48a-82e44112c070`
- Pi session：`019f5f06-b420-7f6b-8dbd-d1eb1b397ffe`
- first stop：`alreadyStopped=false`，snapshot lifecycle=stopped
- second stop：`alreadyStopped=true`
- late prompt：exit 1，`error.code=instance_not_active`
- SIGTERM：输出 `host.stopping` / `host.stopped`，stderr 为空，socket 删除。
- 独立 reviewer 另行验证 SIGINT/SIGTERM 正常路径分别约 12–13ms 完成、exit 0、socket 删除。

真实模型的 prompt/steer 不在本阶段调用；固定 `openai-codex/gpt-5.6-luna`、thinking off、严格 1→2 的订阅验收留到阶段 4。

## 独立审查

- correctness reviewer：**CLEAN**，无 code blocker/fix-now；确认 host dispatch、shutdown admission、receipt/snapshot 校验及 29 项测试。
- user-flow reviewer：代码行为通过；要求在提交前补齐 README 的 Stage 3 命令/receipt 语义和本验证文档，现已完成。

遗留覆盖风险：10 秒强制 `shutdown_timeout` 分支未自动等待执行（避免测试真实等待 10 秒）；正常 SIGINT/SIGTERM 路径已经手工验证。该分支只在正常清理失去响应时终止进程，不承担恢复职责。

## 边界

- receipt 只表示 Pi preflight 已接受，不表示运行完成。
- 客户端超时/断开不取消宿主已经接纳的 prompt 或 stop。
- bounded shutdown 只负责正常信号路径；宿主 crash 时运行终止，不恢复、不重放。
- 不包含 systemd、宿主重启恢复、PTY/TUI、跨机、账号或调度。
