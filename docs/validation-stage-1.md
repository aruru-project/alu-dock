# 阶段 1 验证记录：SDK 单实例探针

日期：2026-07-14  
Pi SDK：0.80.6  
Node：22.21.0

## 结论

**PASS，进入阶段 2。**

已证明：

- 宿主可在 Pi preflight 接受后立即返回结构化 receipt，而完整 `prompt()` Promise 继续由 `ManagedInstance` 持有。
- `agent_end` 不会让宿主提前转 idle；只有 `agent_settled` 更新最终运行结果。
- 成功、最终失败、aborted 和 stopped 有独立结构化投影。
- 真实 Pi SDK session 可被显式 abort，并持久化到独立 JSONL session 文件。
- 默认 resources/extensions 在 `mode=print`、`hasUI=false` 下完成启动，没有出现无人接入永久等待。
- 旧 daemon、WebConsole、Redis bridge 与生产配置没有改动。

## 自动验证

### TypeScript

```text
$ npm run check
exit 0
```

### 单元测试

```text
$ npm test
exit 0
13 tests passed, 0 failed
```

覆盖：

1. preflight receipt 早于完整 runtime Promise；
2. `agent_end` 不是假 idle，`agent_settled` 才稳定；
3. failed / aborted / stopped 状态区分；
4. preflight 拒绝只作为 command rejection，不伪造 settled run；
5. prompt / steer / follow-up 投递约束；
6. delayed preflight admission reservation，拒绝两个普通 prompt 并发进入同一 Pi session；
7. stop 与 delayed preflight 串行，晚到接受不能复活 stopped 实例；
8. 运行在异步 preflight 中 settled 时，请求从 steer/follow-up 漂移为新 prompt 的最终投递跟踪；
9. `agent_settled` 后的 Promise rejection 不覆盖已确定结果，缺失 assistant outcome 时 fail closed；
10. concurrent stop 幂等，clearQueue 生效，abort/dispose 异常仍无条件进入 stopped；
11. 坏客户端 listener 的异常和数据篡改均不进入 Pi 同步事件链或事件环；
12. 有限事件环的单调序号、截断信号和 Infinity/NaN 容量回退。

## 独立审查与修复

首轮 fresh-context reviewer 复现了两个关键竞态：

- 异步 preflight 窗口可让两个普通 prompt 同时进入同一 session；
- stop 期间晚到的 preflight acceptance 可把 stopped 状态改回 running。

当前实现已增加同步 admission reservation、stop/preflight boundary、token/lifecycle 校验，并补齐对应 delayed-preflight 测试。审查同时发现并已修复：preflight rejection 污染 `lastRun`、settled 结果被晚到 Promise rejection 覆盖、listener 可篡改持久事件、cleanup 异常卡死 stopping、非有限 event capacity 造成无界日志。

第二轮 reviewer 又复现了 Pi 的一个公开语义细节：请求在异步 extension input preflight 开始时可能是 steer，但原 run 在等待期间 settled 后，Pi 会重新检查 `isStreaming` 并把它作为新 prompt 执行。receipt 现在在 Pi preflight callback 边界重新判断最终投递，返回 `delivery=prompt, queued=false` 并正确设置新 `activeCommandId`；事件同时保留 `requestedDelivery=steer` 供诊断。对应回归测试已加入。

第三轮 fresh-context 聚焦复审结果：**CLEAN**（无 blocker、无 fix-now）。

## 真实 Pi SDK 探针

### 显式 abort

命令：

```bash
npm run smoke:sdk -- \
  --cwd "$PWD" \
  --prompt "Wait quietly for 30 seconds before replying." \
  --abort-after-ms 100
```

结果：`exit 0`。

关键证据：

- Dock instance：`6096791a-4a47-4d67-937f-294861441cc1`
- Pi session：`019f5ea8-b176-7733-950d-70d7b1653d02`
- 两种身份明确分离。
- receipt 在 `agent_start` 后立即返回，没有等待完整模型调用。
- 100ms 后出现：
  - `control.stop_requested { wasRunning: true }`
  - assistant `stopReason: aborted`
  - `run.agent_end { willRetry: false }`
  - `run.settled { result: aborted }`
  - `instance.stopped`
- 最终状态：
  - `lifecycle=stopped`
  - `execution=idle`
  - `lastRun=aborted`

持久 session：

```text
/home/luziyi/.pi/agent/sessions/--home-luziyi-workshop-alu_dock--/
2026-07-14T03-25-41-622Z_019f5ea8-b176-7733-950d-70d7b1653d02.jsonl
```

文件存在且非空：6 行 / 1239 bytes；header 的 cwd 与 Pi session ID 正确。

### 最终失败投影

一次正常回复 smoke 遇到当前 provider 网络错误 `fetch failed`。Pi 自动执行 3 次 retry；每次 `agent_end` 后状态仍保持 running，最终 `agent_settled` 后正确得到：

- `execution=failed`
- `lastRun=failed`
- `lastError="fetch failed"`

这次环境错误反而验证了 retry 与最终失败边界。smoke 脚本随后补强：若 settled 为 failed，现在会以非零退出，不会把结构化失败误报成 smoke 成功。

## 冻结范围核验

以下仓库 `git status --short` 均为空：

- `/home/luziyi/workshop/alu-daemon`
- `/home/luziyi/workshop/alubot_admin`
- `/home/luziyi/workshop/alubot`

## 遗留风险

- 尚未通过真实控制 socket 验证“客户端 A 退出、客户端 B 接入”；这是阶段 2。
- 正常成功回复的真实 provider 调用受当前网络状态阻挡；状态机成功路径已有确定性单测，阶段 4 仍需补一次真实成功演示。
- `AgentSession.dispose()` 是当前单实例清理边界；需要 `session_shutdown` 资源清理的扩展兼容性留到阶段 4 评估。
- 同进程多实例、共享 cwd 冲突和宿主重启恢复仍未验证，后两项是 V0 非目标。
