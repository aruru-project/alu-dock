# 阶段 2 验证记录：本地宿主与跨客户端观察

日期：2026-07-14  
Pi SDK：0.80.6  
Node：22.21.0

## 结论

**PASS，阶段 2A/2B 的实现与验收合同已满足。**

已证明：

- `DockHost` 可通过当前用户私有 Unix socket 持有内存 registry 与 `ManagedInstance`。
- 创建请求的客户端进程退出后，不会触发实例 stop/abort；独立客户端进程可获得同一 Dock identity、Pi session metadata、结构化状态和事件。
- `events --since` 可重放断线期间的近期事件；`--follow` 在初始快照之后发送去重 live event。
- deterministic delayed runtime 在 Client A 退出后保持 `execution=running`，Client B 观察完成后才由测试显式 settle，不依赖模型速度或真实订阅。
- 真实 Pi SDK host 可通过 CLI create/list/status/events，且不需要发起模型调用。

阶段 2 不提供 prompt/steer/follow-up/stop 命令；这些属于阶段 3。

## 实现范围

- `src/control/protocol.ts`：版本化 JSONL v1 request/response/event envelope 与运行时验证。
- `src/control/json-lines.ts`：严格 LF framing、split UTF-8 与 1 MiB record limit。
- `src/control/dock-registry.ts`：进程内实例权威 registry。
- `src/control/dock-host.ts`：Unix socket 生命周期、私有目录/0600 socket、请求 dispatch、事件 replay/follow、慢客户端断开。
- `src/control/dock-client.ts`：一次性请求与 follow stream client，结构化错误和响应验证。
- `src/cli.ts`：`serve/create/list/status/events` 薄 CLI；仅 serve 动态加载 Pi SDK。

## 自动验证

### TypeScript

```text
$ npm run check
exit 0
```

### 测试

```text
$ npm test
exit 0
27 tests passed, 0 failed
```

阶段 2 新覆盖：

1. JSONL split UTF-8、Unicode separator、超限和缺失 LF；
2. 严格 request fields、游标和实例名称边界；
3. 同一 host 的 concurrent start 串行；两个 host 抢占时失败方不删除成功方 socket；
4. socket parent ownership/private mode 与 socket `0600`；
5. client A create 后退出、client B list/status/events；
6. deterministic in-flight runtime 在 client 切换期间保持 running；
7. settle 后按游标重放 `run.settled`；
8. replay/follow gap 去重、future cursor 不倒退、超大近期事件页有界截断；
9. shutdown 等待已接纳的异步 create，随后停止新实例；
10. host 意外关闭 follow stream 时客户端明确失败，而非成功退出；
11. response + first event 同一 socket chunk 时，客户端先交付 initial result；
12. malformed host response 统一为 `ControlClientError(invalid_response)`；
13. 独立 fixture host + 多个真实 CLI 子进程的跨进程验收。

## 独立 CLI 进程验收

`test/cli-cross-client.test.ts` 启动独立 delayed-host 子进程：

1. CLI 进程 A 执行 `create`，得到 `fixture-instance-1` 后退出；
2. 新 CLI 进程分别执行 `list`、`status`、`events --since 0`；
3. Client B 看到同一 instance、`fixture-pi-fixture-instance-1` 且仍为 running；
4. 测试通过 IPC 显式释放 delayed run；
5. 新 CLI 进程看到 `lastRun=succeeded`，并从旧 cursor 重放 `run.settled`；
6. socket mode 为 `0600`，host shutdown 后 socket 被删除。

## 真实 Pi SDK 控制面 smoke（无模型调用）

宿主和四个 CLI 命令均以独立进程运行：

```text
node dist/src/cli.js --socket <private-dir>/dock.sock serve
node dist/src/cli.js --socket <socket> create --cwd "$PWD" --name stage2-real
node dist/src/cli.js --socket <socket> list
node dist/src/cli.js --socket <socket> status <instanceId>
node dist/src/cli.js --socket <socket> events <instanceId> --since 0
```

结果：exit 0。

关键证据：

- evidence directory：`/tmp/alu-dock-stage2-real-s7zVYK`
- Dock instance：`ac503783-fce9-4c24-a737-a2bb3b64e07f`
- Pi session：`019f5ef3-7863-70f0-824c-eacca7287368`
- session file：`/home/luziyi/.pi/agent/sessions/--home-luziyi-workshop-alu_dock--/2026-07-14T04-47-22-211Z_019f5ef3-7863-70f0-824c-eacca7287368.jsonl`
- create/list/status identity 一致；事件 replay 包含 `instance.created`；socket mode `0600`。
- SIGTERM 输出 `host.stopping` / `host.stopped`，socket 被删除，stderr 为空。

## 审查驱动修复

实施前审查复现并已修复：concurrent start 删除 live socket、shutdown 漏掉 in-flight create、socket privacy window、future cursor 倒退、无界 outbound buffering、client 缺失响应验证及破坏性 stale probe。

完整 diff 审查又复现并已修复：

- follow stream 的意外远端关闭被误报成功；
- 超大实例名称先创建后得到 oversized response，污染 registry；
- response/event 同 chunk 时 CLI 可能先打印 live event；
- fixture IPC shutdown callback 的 TypeScript overload 错误。

每项均有回归测试。修复后的两名 fresh-context reviewer 最终结论均为 **CLEAN**（无 blocker、无 fix-now）。其中一名额外执行了真实/fixture CLI follow、not_found、package bin 安装和 socket 清理验证。

## 依赖与冻结范围

```text
$ npm audit --audit-level=high
found 0 vulnerabilities
```

以下旧仓库 `git status --short` 均为空：

- `/home/luziyi/workshop/alu-daemon`
- `/home/luziyi/workshop/alubot_admin`
- `/home/luziyi/workshop/alubot`

## V0 边界

- registry 和事件 ring 仅存在于宿主进程内；宿主故障即当前运行结束，不恢复、不重放。
- Stage 2 的真实 SDK smoke 不调用模型；真实订阅 1→2 留到阶段 4。
- CLI 是结构化薄客户端，不复刻 stock Pi TUI/PTY。
- 不包含 systemd、跨机、账号、调度或 Extension UI broker。
