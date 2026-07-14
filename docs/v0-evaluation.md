# Alu Dock V0 最终评估

日期：2026-07-14  
最终基线：`95df5f7`  
结论：**PASS — V0 成功，停止 V0 扩建并进入 V0.1 边界规划。**

## 已验证结论

1. Pi SDK session 可由独立本机 Host 持有，Dock instance identity 与 Pi session identity 分离。
2. 创建客户端退出不会取消 Host 持有的运行；用户已明确确认跨客户端连续性验证通过。
3. 新客户端可按 cwd 重连同一 active instance，重放近期结构化事件并继续交互或显式停止。
4. lifecycle、execution、lastRun、receipt、pending queue 和近期事件可以结构化观察，不依赖终端屏幕转发。
5. 薄 TUI 已覆盖自动启动 Host、创建/重连/选择实例、消息流、detach、stop、模型与 thinking 切换。
6. 默认 Pi resources/extensions 已在真实 SDK session 中加载，未发现阻断启动的 extension error。
7. Dock SDK Host 已补齐普通 Pi CLI 的 Undici `EnvHttpProxyAgent` 初始化；隔离测试证明 fetch 与 WebSocket 均命中代理。
8. 旧 `alu-daemon`、Rails WebConsole、Redis bridge、Alubot 和生产部署未修改。

## 验证证据

- deterministic regression：34/34 tests。
- TypeScript check、npm audit、diff check 均通过。
- 双客户端生命周期与控制：阶段 2/3 的独立进程测试和 PTY smoke。
- 真人连续性：用户最终回执为 PASS。
- 模型/thinking：真实 Pi 模型列表与状态栏切换已人工观察；本地 fixture 覆盖选择器和协议状态同步。
- TUI replay：真实失败事件重放验证单条 user message、无空 assistant 重复、单一最终 error。
- 代理：本地假代理分别捕获 fetch/WebSocket 的 `CONNECT`，覆盖 Pi global `httpProxy` 与既有环境变量两种来源。

## 明显收益

- 运行所有权从启动终端移到明确的 Host。
- detach 与 stop 的语义分离；客户端离开后可以从另一入口继续。
- 实例、Pi session、运行状态和控制结果具备稳定结构化身份。
- 真人入口不再要求手动启动服务、复制 instance ID 或逐条操作 JSONL。

## 已知限制

以下不阻塞 V0，并留待 V0.1 规划决定优先级：

- 尚无面向用户的 Host `status/stop/restart` 生命周期命令；当前正常关闭依赖 SIGTERM。
- Host 重启后不恢复内存 registry，也不自动发现/重开旧 Pi session；更不会恢复或重放崩溃时的执行。
- 未建设 systemd、跨机、账号、调度、HA、Extension UI broker 或完整 stock Pi TUI 能力。
- `/follow`、`/status` 等细节体验不属于本轮 V0 成功门禁。

## 产品建议

**GO：开始规划 V0.1，但不要继续向 V0 追加需求。**

V0.1 应先重新确认边界、用户入口与故障语义，再决定 Host 生命周期管理、持久 session 发现/重开及更完整 Pi 能力的优先级。正在执行的任务在 Host 崩溃后不可续命，必须继续作为明确边界，而不是隐式承诺恢复。
