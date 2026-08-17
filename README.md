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
- instance 创建前的工作目录浏览，以及继续、打开、停止、reopen、adopt、forget；
- 多个相互隔离的 Agent Worker；
- Session Work TUI 的 conversation、tools、Queue、model、settings、tree、compaction 和 Extension UI；
- Protocol V2 的权威读取、实时跟随、断线恢复和操作去重；
- Rails/Web 后端可使用的本机 Unix socket 接口；
- 默认关闭、由本机 Hub 配置和配对的 mutual-TLS 网络入口；
- Unix socket 与 mTLS 共用的永久、hash-verified attachment upload 和 Agent 文件工具；
- 显式 `systemd --user` service 管理。

## 快速开始

要求 Node.js `>=22.19.0`。

```bash
npm run install:local
aludock service status

aludock                       # Dock Hub；New 可先浏览并确认工作目录
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

## 远程访问

本机运行 `aludock` 后：

1. 在 **Settings** 选择网络端口并启用 Remote Access；
2. 在 **Pairing** 显式打开五分钟配对窗口；
3. 从远程客户端发起配对；
4. 在 Pairing 中选择设备，输入客户端屏幕显示的四位 PIN；
5. 配对成功后，客户端使用双方长期证书连接同一套 Protocol V2。

私有 Unix socket 不使用 TLS 或配对，并继续按原方式工作。网络地址和端口不是设备身份；同一客户端和 Host 保留原证书时，切换局域网地址、域名或 NAT 映射不要求重新配对。Pairing、Settings 和吊销只能在 Host 本机 Hub 操作，远程 Protocol V2 客户端不能调用。

## 文件附件

Hub **Settings → Attachment directory** 配置 Host 上的永久 storage root；默认是 `${XDG_DATA_HOME:-~/.local/share}/alu-dock/attachments`。本机和已配对客户端都通过 `attachments.v1` 分块上传，最大 512 MiB，声明 size/SHA-256 后由 Host 独立验证并按内容复用。客户端只收到 opaque `fileId`、名称、大小、可选 media type、digest 和存储时间，永远不收到 Host path。

`command.submit` 用 structured file IDs 关联附件；Queue、live conversation 和 history 显示同一 metadata。Pi 通过内建 `dock_attachment_list` / `dock_attachment_resolve` 工具按需访问，并在修改或解压前先复制永久原件。详细 wire contract 见[客户端接入文档](docs/client-integration.md#附件)。

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
- 客户端接入：[`docs/client-integration.md`](docs/client-integration.md)
- 测试：[`docs/qa.md`](docs/qa.md)
- 本地安装：[`docs/local-install.md`](docs/local-install.md)
