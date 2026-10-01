# Alu Dock

## 先读这个

[`STORY.md`](STORY.md) 是产品目标，效力高于本文件和所有架构文档、卡片、测试。
实现、文档、卡片或测试与它冲突时，停下来问用户，不要自行缩小、绕开或重新解释。
本文件只解释怎样接近它。

## 项目是什么

Alu Dock 是本机单用户的 Agent 运行与控制主体。它提供长期 Host Service、受管工作实例、统一协议，以及官方 Desktop/Android Client、TUI 和自定义 Client 等多个入口，让 Agent 工作可以脱离单个终端持续运行、观察和接管。

当前唯一 Agent 实现是 Pi，也是当前的成熟基底；其他 Agent（如轻量语音）可通过新的 Worker adapter 接入。官方 Desktop/Android Client 属于 Alu Dock 的第一方产品。

## 架构

```text
Official Desktop/Android / Hub TUI / Work TUI / custom clients
                              │
                         Protocol V2
                              │
                       Dock Host Service
                  control authority + session gateway
                              │
                      private Worker transport
                              │
                         Agent Worker
                              │
                         Agent adapter
                              │
                     Pi / future Agent runtime
```

- **Protocol V2** 是 Dock 对客户端的协议。客户端不直连 Worker，也不接触 Agent 私有对象或私有存储。
- **Host** 管理 instance、catalog、operation、Queue、controller、generation 与 Worker 生命周期，并把 Agent 会话流量路由到正确的 Worker。Host 不重新实现 Agent runtime，也不改写 Agent 内容。
- **Worker** 持有完整 Agent runtime、session、tools、extensions、components、callbacks 与 Promise。Agent adapter 在这里完成 Agent 与 Dock 协议之间的转换。
- **客户端** 各自实现所需界面。一个客户端尚未支持某项能力，不影响 Agent、其他客户端或已经工作的能力。Hub/Work TUI 随 Alu Dock 同包安装、只连本机 Host（SSH 是登录到那台机器再运行它），不存在跨版本的 TUI↔Host 组合；官方 Desktop/Android Client 和自定义 Client 才是远程连接、需要配对和兼容考虑的对象。
- **本仓库承载一个 Alu Dock 产品**：Host、Worker、Hub/Work TUI 和 `clients/official/` 下的官方 Desktop/Android Client。官方 Client 的 Rust core、Tauri 外壳与 Vue UI 保持自己的语言和构建边界，共同遵循根目录的产品语义、Protocol 与跨层工程规则。Rails Web Console 等自定义 Client 继续通过 Protocol V2 对接并由各自项目维护，禁止跨项目修改其代码。
- 新增使用既有能力的 Agent，主要增加 Worker adapter 和 runtime 注册；新增真正的 Agent 能力时，在 Protocol V2 定义一次，再由需要它的客户端实现。
- 同一能力只保留一个 Dock 协议定义：Worker adapter 产出 Protocol V2 结果体 → `protocol.ts` 定义一次 parser → Worker 边界与客户端复用它 → Host 只合并自己的事实。Worker↔Host、Host↔客户端均沿这条路径接入；逐方法 proxy、重复 DTO、重复 projection 或模拟对端的兼容壳须收敛到这一边界。
- 界限常量（字节、条目、字符上限）只在产出端定义一次，其他位置复用；同一上限的重复定义按缺陷收敛。没有调用方的代码和只写不读的状态发现即删。

## 工程入口

| 范围 | 文档 |
|---|---|
| Instance identity、位置透明性与命令接纳 | [`docs/agent_maps/instance.md`](docs/agent_maps/instance.md) |
| Protocol V2、Host、DockClient、CLI、catalog | [`docs/agent_maps/control.md`](docs/agent_maps/control.md) |
| Agent Worker、Pi adapter、session 与 Extension UI | [`docs/agent_maps/runtime.md`](docs/agent_maps/runtime.md) |
| Pi SDK 依赖升级与独立兼容门 | [`docs/pi-sdk-upgrades.md`](docs/pi-sdk-upgrades.md) |
| Hub 与 Session Work TUI | [`docs/agent_maps/tui.md`](docs/agent_maps/tui.md) |
| 官方 Desktop/Android Client | [模块图谱](docs/agent_maps/official-client.md) · [设计理念](docs/client-design-principles.md) · [开发约定](clients/official/AGENTS.md) |
| Managed service 与部署 | [`docs/agent_maps/deployment.md`](docs/agent_maps/deployment.md) |
| 测试配额、用户可见文案与验证层次 | [`docs/qa.md`](docs/qa.md) |
| 本地安装和运维 | [`docs/local-install.md`](docs/local-install.md) |
| 已知技术债与重访条件（不是任务队列） | [`docs/technical-debt.md`](docs/technical-debt.md) |

## 干活约定

- 开工之前,master一定是干净的, 分支一定是在master的.如果发现情况和约定不符,立刻报告.
- 开工前先查询相关代码做任务规划
- 发现超出需求预估范围外的内容,先申报沟通
- 发现开发机或开发环境异常时，立即暂停相关操作、上报已知影响与不确定性，与用户沟通后再继续。测试环境同样适用；未经授权不得调整系统限制来绕过异常。
- 任何涉及到回复和与用户的沟通使用人类可阅读的通俗语言, 禁止术语黑话字段填充报告.
- 本项目分为 Host、Worker、Client 三个主要部分，各自负责自己的职责，不依赖或重复实现其他模块的内部逻辑，只通过约定的接口协作。Host 与 Worker 的运行和通信不依赖客户端在线或客户端的页面状态。Client 只通过 Protocol V2 向 Host 发请求、接收状态和结果，不直接连接 Worker，也不替 Host 或 Worker 判断和管理其内部运行过程。Host 负责将需要 Worker 处理的请求和结果转发，不把 Worker 的内部实现要求泄漏给客户端。
- 单个模块的任务，不得擅自修改其他模块或扩展共同协议。确有必要时，必须先向用户说明原因、影响和需要扩大的范围，取得明确同意后再实施。
- 凡是新增“必须先等、先查、先刷新，才能操作”的条件，都要说明它对应哪条已确认需求。说不出来，就不能当作技术细节自行加入。
- 评审也应该先看“用户现在多了什么限制”，再看代码有没有正确处理各种状态。


项目使用 Node.js、TypeScript ESM。模块约定写在对应文档中，并在该模块范围内适用。

未经明确授权，不执行真实模型调用、不安装本地版本，也不启动、停止或重启 managed service。
