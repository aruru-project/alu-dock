# Dock 原生 Agent 协作

## 目标与依据

2026-10-31 用户将 agent 协作确定为 Dock 核心：主 Worker 能创建子 Worker、选择模型/思考强度/工具许可，平级 Worker 能通信，协作开发与独立审查真实可用。旧的扁平实例限制、默认人工开关和 Pi subagents 分工不再约束本次设计。

基线：master `3ad4eb4b98e44cee12541abcfc72d7eadc0391e2`。

保留同一 Work 多入口不分叉、客户端离线继续运行、所有工作可见可停、Pi 原生会话与模型目录。复用 Host 的 catalog、operation ledger、Queue 与 Worker 生命周期，不另造工作流引擎。

参考 Codex 的 AgentControl/child_config：创建与配置由运行时管理，普通协作消息与中断分开；参考 AutoGen 的消息信封：来源由系统确定，不靠模型自报。持久会话不等于消息可靠投递，不能在不确定结果后自动重放副作用。

- https://github.com/openai/codex/blob/main/codex-rs/core/src/agent/control.rs
- https://github.com/openai/codex/blob/main/codex-rs/core/src/agent/child_config.rs
- https://microsoft.github.io/autogen/stable/user-guide/core-user-guide/framework/message-and-communication.html

## 实施顺序

1. 将父子关系持久化在 Work 身份中，所有客户端继续访问同一 Work。
2. 原生创建子 Worker：指定任务、模型、思考强度与精确工具许可。先创建再提交任务；创建成功但启动任务失败时返回子 Work 身份和明确失败，不伪装成功，不重复创建。
3. 普通消息默认排到对方当前轮次之后；需要打断时明确调用 interrupt。消息只加简洁且真实的来源，不加反复的防御性说明。
4. 协作工具默认可用，保留用户主动关闭的控制。权限在 Pi 实际工具分发处落实，覆盖嵌套调用；工具许可不是文件系统沙箱。
5. 官方客户端展示父子关系、创建子任务并直接进入查看/操作。独立 review 使用只读工具集合，结果发回负责人，负责人整合修改。
6. 用真实 Host → 独立 Worker → Pi SDK 的本地确定性模型验证分工、消息、审查发现缺陷、修正、停止和恢复。再独立审查代码和可见界面。

## 生命周期与失败语义

子 Work 是独立的可见工作，停止负责人不会悄悄删除子任务或结果。停止某个 Worker 与中断其当前一轮分开。Host 重启后沿既有规则显示中断状态并可 reopen，不擅自重放模型调用和外部副作用。观察订阅是当前运行期的通知，恢复后重新读工作状态。

普通协作消息不抢占正在执行的工具。接收方空闲时可开始新轮次，忙时排队；回执表示接受而非已完成。任务提交失败时应 inspect 已创建子任务，不能只凭错误再 spawn 一份。

## 验收例子

负责人接到小型代码任务，创建调查者、实现者、只读 reviewer，设置各自模型与思考强度。调查者把结论直接发给实现者；reviewer 阅读变更，找出测试中的注入缺陷并发回；实现者修正后再次审查，负责人交付。用户随时从已有 Work 列表进入任意成员、看配置、发消息、中断或停止，不再安装 Pi subagents。

### Delegated project trust

A live worker's resolved project-trust decision may be reused for its child in exactly the same canonical workspace. The source Host binds this to one child-creation operation and the originating runtime object, in memory only. Main/SubHost routing preserves that operation identity; another machine or directory must pass its own ordinary trust check. Stopping/replacing the source invalidates its outstanding grants. Session-switch trust updates the live decision. Neither `trust_once` nor a caller-supplied trust boolean is persisted as delegation authority.
