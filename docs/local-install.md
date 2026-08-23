# 本地安装与服务

Alu Dock 使用一个本机 npm 安装和一个 `systemd --user` Host Service。

## 位置

```text
~/.local/share/alu-dock/
~/.local/bin/aludock
~/.config/systemd/user/alu-dock.service
```

Host 和 Worker 从安装包自己的依赖加载 Agent runtime，不调用 `$PATH` 中的全局 Pi。生成的 user unit 只保存 Host 启动所需的固定 Node、CLI、HOME 和最小可执行 PATH，不固化安装命令当时的语言版本、npm PATH 或开发环境，也不替 Extension source 凭据文件。每个 Worker 在启动时从用户登录 shell 和自己的 workspace 独立取得开发环境。更新 Alu Dock 不删除 catalog、Agent session 或 remote-access identity/trust 文件。

默认持久状态位于 `~/.local/state/alu-dock/`；managed service 使用 systemd 提供的同一用户私有 `STATE_DIRECTORY`。`remote-access/identity.json` 是长期 Host TLS identity，`remote-access/trusted/` 是已配对客户端证书。迁移或备份 Host 时必须把这两者作为一个私有状态单元处理；删除或丢失 Host identity 会使客户端已有的 Host pin 失效并需要重新配对。Settings 中关闭网络监听、更新程序或普通 service restart 都不会轮换证书或删除 trust。

Attachment directory 设置保存在同一 private state 下的 `attachment-storage.json`。默认 bytes 位于 `~/.local/share/alu-dock/attachments/`（或 `$XDG_DATA_HOME/alu-dock/attachments/`），也可以在本机 Hub Settings 改为其他绝对永久路径。备份或迁移必须整体保存 `files/` 和 hidden `.alu-dock/` manifests；只备份其中一边会使 opaque `fileId` 无法恢复。Successful attachments 不随 update、service uninstall/restart、catalog forget/prune、remote disable 或 device revocation 删除。

## 安装或更新

从要安装的工作区执行：

```bash
npm run install:local
aludock service status
```

安装器构建当前 checkout，更新本地包、launcher 和 user service，然后等待 Host ready。它不运行测试，也不自动回滚。

存在未完成 run、Queue、interaction 或 stopping instance 时，安装默认拒绝。只有明确接受中断这些工作时才使用：

```bash
npm run install:local -- --replace-active
```

替换 Alu Dock 会中断未完成的回答、等待消息和交互；请先完成或停止重要工作。

## Service 命令

```bash
aludock service install [--now]
aludock service start
aludock service stop
aludock service restart
aludock service status
aludock service logs [--lines N] [--follow]
aludock service uninstall
```

使用 `aludock`、`-c`、`new` 或 `attach` 前，请先用 `aludock service start` 启动后台服务。卸载后，Dock History、已保存的 Pi 会话、附件设置和附件文件仍保留在原位置。

需要跨 logout 常驻时，由用户显式启用 linger：

```bash
loginctl enable-linger "$USER"
```

## 排查

```bash
command -v aludock
readlink -f ~/.local/bin/aludock
aludock service status
aludock service logs --lines 200
aludock list --all
```

未经明确授权，不执行安装、替换 active Host 或 service restart。

## Windows 源码前台运行（先期）

Windows 当前不需要安装包或后台 Service。从源码工作区安装依赖后，使用两个 PowerShell 窗口。

第一个窗口启动并保持 Host；`Ctrl+C` 进入正常关闭：

```powershell
npm ci
npm run host:windows
# 或直接运行 .\scripts\Start-AluDockHost.ps1
```

第二个窗口按需打开人使用的界面；离开界面不会停止第一个窗口中的 Host：

```powershell
npm run open:windows
# 或直接运行 .\scripts\Open-AluDock.ps1
```

Main 打开完整 Hub，SubHost 打开最小管理界面。`Open-AluDock.ps1` 不重复构建或启动 Host；首次使用时先运行 Host 入口。

默认状态保存在 `%LOCALAPPDATA%\Alu Dock\`，本地 Protocol V2 入口是 `\\.\pipe\alu-dock`。本地 Named Pipe 不使用远程设备配对。

没有角色配置时 Host 脚本默认启动 Main，且 SubHost connections 关闭。Main Hub 的 Machines 可以实时打开或关闭连接、选择端口、保存一次供新 SubHost 使用的 Main 地址并创建 join file。地址只在第一次连接 SubHost 时输入，端口直接使用 Machines 当前设置；两者随 join file 交给另一台电脑。

角色只由保存的 Settings 决定，没有进程级角色覆盖。将 Windows 配置为 SubHost 时，在人的界面中选择 Settings → Dock role，导入 Main 创建的 join file，然后确认系统机器名和文件中携带的 Main 连接。只有明确选择 Edit Details 才需要修改地址、端口或名称。界面会同时保存待完成的 enrollment 和下次启动角色；按照确认页提示，在十分钟有效期内停止当前 Main，并直接使用普通无参数入口：

```powershell
.\scripts\Start-AluDockHost.ps1
```

切回 Main 不会删除原来的 Main enrollment 或连接资料；以后再次选择同一个 SubHost 角色只需确认 Use Saved Connection。只有选择 Connect to a Different Main 才需要新的 join file。

Windows Remote Access 仍使用普通 TLS 设备配对；它与本地 Named Pipe 是两个入口。当前先期范围不包括 Windows Service、Scheduled Task、开机启动、安装包和自动更新。
