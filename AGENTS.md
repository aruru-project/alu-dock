# Alu Dock

## 先读这个

[`STORY.md`](STORY.md) 是产品目标，效力高于本文件和所有架构文档、卡片、测试。
实现、文档、卡片或测试与它冲突时，停下来问用户，不要自行缩小、绕开或重新解释。
本文件只解释怎样接近它。

## 项目是什么

Alu Dock 是本机单用户的 Agent 运行与控制主体。它提供长期 Host Service、受管工作实例、统一协议和多个客户端入口，让 Agent 工作可以脱离单个终端持续运行、观察和接管。

当前唯一 Agent 实现是 Pi。Pi 是当前成熟基底，不是 Alu Dock 永久唯一的 Agent 类型；未来可以通过新的 Worker adapter 接入轻量语音等其他 Agent。

## 架构

```text
Hub TUI / Work TUI / Rails-WebUI / future clients
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
- **客户端** 各自实现所需界面。一个客户端尚未支持某项能力，不影响 Agent、其他客户端或已经工作的能力。
- **本项目范围仅限 Dock 本身**：Host、Worker，以及本项目内部的 Hub TUI 和 Work TUI。其他第三方实现全部通过 Protocol V2 对接并由各自项目维护，禁止跨项目修改其他项目代码。
- 新增使用既有能力的 Agent，主要增加 Worker adapter 和 runtime 注册；新增真正的 Agent 能力时，在 Protocol V2 定义一次，再由需要它的客户端实现。
- 同一能力只保留一个 Dock 协议定义。任意两层之间（Worker↔Host、Host↔客户端）都不得用逐方法 proxy、重复 DTO、重复 projection 或兼容壳模拟对端。新增能力沿唯一路径：Worker adapter 产出 Protocol V2 结果体 → `protocol.ts` 定义一次 parser → Worker 边界与客户端复用它 → Host 只合并自己的事实。
- 界限常量（字节、条目、字符上限）只在产出端定义一次，第二处出现同一数值按缺陷处理。没有调用方的代码和只写不读的状态发现即删，不等专项清理。

## 工程入口

| 范围 | 文档 |
|---|---|
| Protocol V2、Host、DockClient、CLI、catalog | [`docs/agent_maps/control.md`](docs/agent_maps/control.md) |
| Agent Worker、Pi adapter、session 与 Extension UI | [`docs/agent_maps/runtime.md`](docs/agent_maps/runtime.md) |
| Pi SDK 依赖升级与独立兼容门 | [`docs/pi-sdk-upgrades.md`](docs/pi-sdk-upgrades.md) |
| Hub 与 Session Work TUI | [`docs/agent_maps/tui.md`](docs/agent_maps/tui.md) |
| Managed service 与部署 | [`docs/agent_maps/deployment.md`](docs/agent_maps/deployment.md) |
| 测试配额、用户可见文案与验证层次 | [`docs/qa.md`](docs/qa.md) |
| 本地安装和运维 | [`docs/local-install.md`](docs/local-install.md) |

## 干活约定

- 动手前申报预期规模（改哪些文件、预计多久）；实际超过预期约两倍时停下汇报，不静默加倍努力。
- 范围以主人点名为准：点名一项就做一项，点名整卡才推进整卡；checklist 的下一项、顺路发现的问题记录上报后等点名。唯一例外是架构节预授权的无调用方死代码删除。
- 临时实现（mock、占位、写死值、跳过的错误路径）在代码 TODO 和交付报告"还没证明"里双处申报；未申报的降级按缺陷处理，并召回整份交付重审。
- 交付报告固定三段：完成内容 / 测了什么 / 还没证明。diff 规模与任务规模对账，超出部分逐项解释归属。

项目使用 Node.js、TypeScript ESM。实现任务先读对应模块文档和直接相关代码，不把某个模块的实现细节提升成全项目规则。

未经明确授权，不执行真实模型调用、不安装本地版本，也不启动、停止或重启 managed service。
