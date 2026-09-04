# 本地安装与服务

Linux checkout 使用 npm 本地安装入口，并由 `systemd --user` 托管 Host。Windows 使用官方 x64 ZIP 与一次性 `Setup.cmd`，由随包 Node 在当前用户 session 中运行隐藏 Host；Windows checkout 的同名 npm 本地安装入口先生成该 ZIP，再调用同一 Setup。Desktop 提供托盘与可选登录启动，不创建 Windows Service、Scheduled Task 或长期终端窗口。

## 位置

```text
~/.local/share/alu-dock/
~/.local/bin/aludock
~/.config/systemd/user/alu-dock.service
```

Host 和 Worker 从安装包自己的依赖加载 Agent runtime，不调用 `$PATH` 中的全局 Pi。生成的 user unit 只保存 Host 启动所需的固定 Node、CLI、HOME 和最小可执行 PATH，不固化安装命令当时的语言版本、npm PATH、`PI_CODING_AGENT_DIR` 或开发环境，也不替 Extension source 凭据文件。Managed Host 启动时从用户 login shell 解析 Pi 原生 agent directory，并让 inventory 和 Worker 共用该结果；Dock 不持久化另一份路径设置。每个 Worker 仍从用户登录 shell 和自己的 workspace 独立取得开发环境；Worker 内的 `pi` 与 `aludock` launcher 固定回到这个安装包。更新 Alu Dock 不删除 catalog、Pi 原生 session 或 remote-access identity/trust 文件。

默认持久状态位于 `~/.local/state/alu-dock/`；managed service 使用 systemd 提供的同一用户私有 `STATE_DIRECTORY`。`remote-access/identity.json` 是长期 Host TLS identity，`remote-access/trusted/` 是已配对客户端证书。迁移或备份 Host 时必须把这两者作为一个私有状态单元处理；删除或丢失 Host identity 会使客户端已有的 Host pin 失效并需要重新配对。Settings 中关闭网络监听、更新程序或普通 service restart 都不会轮换证书或删除 trust。

Attachment directory 设置保存在同一 private state 下的 `attachment-storage.json`。默认 bytes 位于 `~/.local/share/alu-dock/attachments/`（或 `$XDG_DATA_HOME/alu-dock/attachments/`），也可以在本机 Hub Settings 改为其他绝对永久路径。备份或迁移必须整体保存 `files/` 和 hidden `.alu-dock/` manifests；只备份其中一边会使 opaque `fileId` 无法恢复。Successful attachments 不随 update、service uninstall/restart、catalog forget/prune、remote disable 或 device revocation 删除。

## Linux 安装或更新

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

## Pi 配置与扩展

Alu Dock 不要求系统另外安装 Pi。运行 `aludock` 后可在 **Settings → Pi** 查看随包 Pi 当前识别的 models，并让 Pi 自己保存 API key 或完成 OAuth 登录。配置位置仍是 Pi 原生 `~/.pi/agent/`（或 `PI_CODING_AGENT_DIR`），Session 仍在 Pi 原生 `sessions/`；Alu Dock 不创建另一份凭据或会话目录。

安装 Pi package 使用：

```bash
aludock pi:install <npm、git 或本地 source>
```

命令使用随包 Pi 的 package manager 和 package conventions，写入 Pi global settings，不依赖 `$PATH` 中的 Pi。已经运行的 Work 使用 `/reload` 采用 extension/config 变化。

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

## Windows 官方发行

在原生 x86_64 Windows 的 Visual Studio Developer terminal 中组装验收包：

```powershell
npm run package:windows
```

完整包构建使用开发机 Node/npm，构建 MSVC Tauri Desktop，安装 Dock production dependencies（其中包含 bundled Pi），检查所有随包 PE 文件的 x64 架构和非系统 DLL 依赖，再生成唯一的 Windows 产物：

```text
clients/official/dist/AluDock-<version>-windows-x86_64.zip
```

正式 Release 会根据上一次成功发布的正式 Release tag 以来实际变化选择产物；只有 tag 而没有成功 Release 的版本不会截断变化范围。只有 Host、Worker、Pi adapter 或 bundled Pi 变化时，Windows job 下载最近一次成功发布的完整 Windows ZIP 并校验 `SHA256SUMS.txt`，复用其中的 Desktop 和 DLL，只替换当前 Dock、bundled Pi、Setup、launcher 和发行元数据；不安装 Rust，也不重新构建 Tauri/前端。共享客户端变化仍执行完整构建；未知构建输入保守构建全部平台。两条路径最终都只产出一个可全新安装、也可直接升级的当前版本完整 ZIP。

最终用户先安装满足根 `package.json#engines.node` 的官方 Node.js，再完整解压 ZIP 并运行一次 `Setup.cmd`。Setup 在停止旧 Host 前通过包内唯一 launcher 检查系统 Node，随后拒绝仍有 active Work 的更新、把新目录先复制到 sibling staging，再切换唯一安装位置并等待 Host ready。上一版本和事务记录会保留到新版本 ready、命令入口、Start Menu 与卸载登记全部完成；失败会恢复并重新启动上一版本，异常中断后的再次运行先完成恢复。重复执行同一版本也会从完整包重新暂存并替换安装目录、修复这些入口并确认 Host ready，而不是只根据版本号提前退出：

```text
%LOCALAPPDATA%\Alu Dock\app\AluDock.exe
%LOCALAPPDATA%\Alu Dock\app\aludock.cmd
%LOCALAPPDATA%\Alu Dock\app\Uninstall.cmd
%LOCALAPPDATA%\Alu Dock\app\dock\
%LOCALAPPDATA%\Alu Dock\bin\aludock.cmd
%LOCALAPPDATA%\Alu Dock\logs\host.log
```

Setup 不需要管理员权限或系统 Pi，但需要 Windows 已安装兼容 Node.js；Alu Dock 不安装、更新或卸载 Node。它维护 Start Menu 中的 Desktop 入口、Windows Apps 中的卸载项，以及由 `%LOCALAPPDATA%\Alu Dock\bin` 提供的全局 `aludock` 命令；旧 npm local-install launcher 只在确认由 Alu Dock 生成后才会移除。若旧 Desktop 仍占用安装目录，Setup 会要求先从托盘选择 **退出 Desktop** 后重试；它不会为了更新强杀 GUI 或 active Work。当前包不签名、不发布、不自动更新。

完成 Setup 后，`AluDock.exe` 是日常 Desktop 入口。它使用同一 Windows lifecycle authority 确保隐藏 Host ready，然后通过 `\\.\pipe\alu-dock` 连接 Protocol V2；首次无既有 Client 选择的 Main 会自动选择本机，不走设备配对。重复启动唤起已有 Desktop，不创建第二个 Host。

- X 隐藏 Desktop 到托盘；Host、Worker 和 Work 不停止。
- **退出 Desktop** 只退出 GUI。
- **停止 Alu Dock** 单独请求 Host 正常停止，active Work 存在时拒绝。
- **更新模型** 调用与 `aludock update model` 相同的 bundled Pi 模型目录刷新能力。
- **随 Windows 登录启动** 默认关闭；启用后以 `--background` 静默进入托盘并确保 Host ready。
- **打开终端设置** 启动随包 `aludock.cmd`；Main/SubHost 角色及连接继续由同一个 TUI Settings 和 Host private state 管理。
- 托盘启动、停止和更新模型会先显示进行中通知，再显示完成或可执行的失败提示；Host 日志仍可从托盘和界面打开。

新开的 PowerShell 或 cmd 可以直接进入同一个 TUI 或 service authority：

```powershell
aludock
aludock service status
aludock service logs --lines 200
aludock update model
```

Windows logoff 或重启会结束当前用户 Host；启用登录启动后，下一次登录由 Desktop 恢复。更新不删除 `%LOCALAPPDATA%\Alu Dock\` 中的 catalog、Machine 设置、enrollment、attachments、Host identity/trust 或日志，也不改变 Pi 原生配置和 Session 位置。

从 Windows Apps 或安装目录运行 `Uninstall.cmd` 会先要求退出 Desktop，并在 active Work 存在时拒绝停止 Host；随后移除应用目录、上一版本、登录启动、Start Menu、卸载登记和全局 `aludock` launcher。它保留上述 Dock 状态和全部 Pi 原生状态，之后重新安装可继续使用。

源码调试仍可显式运行 `node dist/src/cli.js host` 与 Tauri dev，但它们不定义正式 Windows 生命周期。Windows checkout 中的 `npm run install:local` 会构建当前官方 ZIP、解压到临时目录并调用其中的 Setup，因此与最终用户安装保持同一布局和生命周期。Windows Remote Access 继续使用普通 TLS 设备配对；它与免配对本机 Named Pipe 是两个入口。
