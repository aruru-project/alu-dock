# Alu Dock

Alu Dock 是本机单用户的 Agent 运行与控制主体。长期 Host Service 持有工作实例和 Worker 生命周期，SSH TUI、Rails/WebUI 以及未来客户端通过统一的 Protocol V2 连接。客户端退出后，Agent 工作可以继续运行，之后再重新接入。

当前唯一 Agent 实现是 Pi。Pi runtime 在每个 active instance 自己的 OS Worker 中运行；未来可以通过新的 Worker adapter 接入其他 Agent。

```text
Hub / Work / Web / future clients
               │
          Protocol V2
               │
       Dock Host Service
               │
          Agent Worker
               │
       Pi / future Agent
```

## 当前能力

- 长期 Host 与 durable instance catalog；
- instance 创建、继续、attach、停止、reopen、adopt、forget；
- 多个相互隔离的 Agent Worker；
- Session Work TUI 的 conversation、tools、Queue、model、settings、tree、compaction 和 Extension UI；
- Protocol V2 的 snapshot、event follow、cursor reconnect 和 mutation operation identity；
- Rails/Web 后端可使用的本机 Unix socket 接口；
- 显式 `systemd --user` service 管理。

## 快速开始

要求 Node.js `>=22.19.0`。

```bash
npm run install:local
aludock service status

aludock                       # Dock Hub
aludock -c                    # 继续当前项目；没有则 New
aludock new --cwd "$PWD" --name demo
aludock attach TARGET
aludock list
```

离开 Hub 或 detach Work 不会停止 instance。需要结束 Agent runtime 时显式执行：

```bash
aludock stop TARGET
```

Service 只由显式命令管理：

```bash
aludock service start
aludock service stop
aludock service restart
aludock service status
aludock service logs --lines 200
```

`forget` 和 `prune` 只删除 Dock catalog record，不删除 Agent session 文件。

## 从源码运行

安装依赖：

```bash
npm install
```

开发 Host 和 CLI 使用同一个 dev socket：

```bash
# terminal 1
export ALU_DOCK_SOCKET="${XDG_RUNTIME_DIR:-$HOME/.alu-dock/run}/alu-dock-dev.sock"
npm run serve
```

```bash
# terminal 2
export ALU_DOCK_SOCKET="${XDG_RUNTIME_DIR:-$HOME/.alu-dock/run}/alu-dock-dev.sock"
npm run cli
```

真实模型 smoke 只在明确授权后运行。

## 文档

- 工程入口：[`AGENTS.md`](AGENTS.md)
- Host 与 Protocol V2：[`docs/agent_maps/control.md`](docs/agent_maps/control.md)
- Agent Worker 与 runtime：[`docs/agent_maps/runtime.md`](docs/agent_maps/runtime.md)
- Hub 与 Work TUI：[`docs/agent_maps/tui.md`](docs/agent_maps/tui.md)
- 部署：[`docs/agent_maps/deployment.md`](docs/agent_maps/deployment.md)
- Web 接入：[`docs/web-client-integration.md`](docs/web-client-integration.md)
- 测试：[`docs/qa.md`](docs/qa.md)
- 本地安装：[`docs/local-install.md`](docs/local-install.md)
