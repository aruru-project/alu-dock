# Alu Dock

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
- 新增使用既有能力的 Agent，主要增加 Worker adapter 和 runtime 注册；新增真正的 Agent 能力时，在 Protocol V2 定义一次，再由需要它的客户端实现。
- 同一能力只保留一个 Dock 协议定义。不得通过逐方法 proxy、重复 DTO、重复 projection 或兼容壳在 Host 与 Worker 间模拟本地 runtime 对象。

## 工程入口

| 范围 | 文档 |
|---|---|
| Protocol V2、Host、DockClient、CLI、catalog | [`docs/agent_maps/control.md`](docs/agent_maps/control.md) |
| Agent Worker、Pi adapter、session 与 Extension UI | [`docs/agent_maps/runtime.md`](docs/agent_maps/runtime.md) |
| Hub 与 Session Work TUI | [`docs/agent_maps/tui.md`](docs/agent_maps/tui.md) |
| Managed service 与部署 | [`docs/agent_maps/deployment.md`](docs/agent_maps/deployment.md) |
| 测试配额、用户可见文案与验证层次 | [`docs/qa.md`](docs/qa.md) |
| 本地安装和运维 | [`docs/local-install.md`](docs/local-install.md) |

项目使用 Node.js、TypeScript ESM。实现任务先读对应模块文档和直接相关代码，不把某个模块的实现细节提升成全项目规则。

未经明确授权，不执行真实模型调用、不安装本地版本，也不启动、停止或重启 managed service。
