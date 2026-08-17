# Managed Host 与部署

## 这部分负责什么

Alu Dock 使用一个长期 `systemd --user` Host Service。每个 active instance 的 Agent runtime 运行在独立 Worker 进程中。

```text
systemd --user
      │
Dock Host Service
      ├── private Unix socket
      ├── optional mutual-TLS network port
      ├── durable catalog + private Host settings
      ├── permanent attachment store
      └── supervised Agent Workers
```

## Host startup

Managed Host 启动时：

1. 绑定并验证私有 Unix socket；
2. 加载 durable catalog；
3. 对上一次 Host 遗留状态做保守恢复；
4. 进入 ready；
5. 只有显式 create、continue、adopt 或 reopen 才启动 Worker。

Startup 不自动恢复或重放旧 prompt、Queue、interaction、Promise 或 tool effect。

Host unit 只定义 service 自己的固定 Node、CLI、HOME、最小 PATH 和 managed runtime 变量。安装器不得把执行安装时的 PATH、RVM/NVM 选择、npm lifecycle 环境或 Extension 凭据复制进 unit；这些既不是 Host 配置，也不能成为所有 Worker 的全局开发环境。

## 网络入口与配对窗口

私有 Unix socket 始终是本机入口，路径所有权和 mode 保持既有行为。可选的远程 listener 是另一种 Protocol V2 transport：默认关闭，由本机 Hub Settings 启用并配置端口；启用时绑定 `::` 且允许 dual-stack，不替代、转发或改变 Unix socket。修改端口时先关闭旧 listener 和它的远程连接，再绑定新端口；新端口绑定失败时保持网络入口关闭并在 Settings 显示错误，不能暗中继续暴露旧端口。

网络端口始终提供 Host TLS certificate。已配对客户端必须发送精确受信任证书，才会进入同一个 Protocol V2 handler。Pairing 页面打开的五分钟窗口只在该端口上临时增加 unknown-certificate pairing bootstrap；它不会开启新的管理端口，也不会把 Settings、吊销或配对窗口控制暴露给网络。窗口成功、失败、超时、关闭、Host restart 或 remote listener disable 时，所有 provisional pairing state 都被清理；已配对证书信任保留。

部署方负责防火墙、NAT 和端口映射。映射外部地址或端口不会改变 Host/client certificate identity，也不需要重新配对。未知连接仍会消耗一次 TCP/TLS handshake，因此公网部署应保留系统防火墙和常规连接速率保护；应用内部的 handshake deadline、连接上限、request/body 上限和 pairing transaction 上限是最后一道边界，不是 DDoS 清洗服务。

## 永久附件目录

Managed Host 创建一个 `AttachmentService`，同时注入 Protocol V2 ingress 和 Registry 的 Worker reverse capability。默认目录是 `${XDG_DATA_HOME:-~/.local/share}/alu-dock/attachments`；实际绝对路径保存在 Host private state 的 `attachment-storage.json`，只能从本机 Hub Settings 修改。Unix socket 和 mTLS 不各自拥有 store，远程 endpoint 或证书变化也不迁移文件。

Store 的公开内容在 `files/`，文件名经过最小安全清洗并保持可读；`.alu-dock/manifests/` 保存 digest/fileId metadata，`.alu-dock/tmp/` 只保存未完成上传。目录和文件分别固定为 user-private mode，managed 子目录不能是 symlink。Startup 删除 tmp 和没有 manifest 引用的 provisional content，但不删除 successful attachment。没有 TTL、自动 GC 或 quota。

已经有 manifest 时 Settings 拒绝直接改变目录。管理员若要迁移，必须在 Host 停止后整体移动目录（包括 hidden `.alu-dock/` 与 `files/`），确认 owner/mode 与完整内容；重新启动后先在 Hub Settings 指向新 canonical path，再允许任何客户端上传，不能只复制可见文件。普通安装、升级、restart、remote listener change 或 client revocation 都不移动或删除附件。

## Worker lifecycle

Host 为每个 active instance 创建独立 Worker，并负责：

- Worker identity 与 runtime generation；
- process group、termination deadline 与 direct-child reap；
- replacement 和旧 Worker fencing；
- Worker loss后的保守 instance 状态；
- 无法确认 owner release 时的 quarantine。

Worker 与 Host IPC 断开后必须自行终止，不能成为孤儿 runtime。Host 不能在旧 owner 尚未确认释放时为同一 Agent session 创建新 owner。

## Host shutdown 与 loss

正常 shutdown 停止接收新 mutation，处理已接收工作的关闭边界，提交必要 catalog 状态，并终止所有 Worker。

Host 被强制终止时没有 cleanup 保证。下一次启动只使用 durable catalog 和 Agent session metadata 判断可执行动作，不猜测内存中的工作结果。

## Service 管理

普通 Hub、Work、`new`、`attach` 和 Web 请求只连接已有 Host，不安装、启动或重启 service。

Service 生命周期只能由显式命令管理：

```bash
aludock service install [--now]
aludock service start
aludock service stop
aludock service restart
aludock service status
aludock service logs [--lines N] [--follow]
aludock service uninstall
```

## 本地安装

本地安装更新 `~/.local/share/alu-dock` 中的包、launcher 和 user service。安装与测试是两件事；安装器不替代测试。

存在未完成 run、Queue、interaction 或 stopping instance 时，安装默认拒绝。显式替换 active Host 会中断这些工作，也不会迁移或重放内存状态。

未经用户明确授权，不执行安装、service restart 或真实模型调用。

## 代码范围

- `src/deployment/`：安装布局和 user service 管理。
- `scripts/install-local.ts`：本地打包与安装入口。
- `src/control/dock-host.ts`：Host socket 与 shutdown。
- `src/control/durable-catalog-store.ts`：durable catalog。
- `src/control/attachment-storage-state.ts`、`attachment-service.ts`：Host-private directory setting 与 permanent attachment store。
- `src/control/catalog-reconcile.ts`：Host startup recovery。
- `src/pi/worker-process.ts`：Worker process supervision。
- `src/pi/pi-worker-entry.ts`：当前 Pi Worker 入口和 Host-loss shutdown。

部署代码只管理进程、文件和 service，不实现 Agent session 能力。
