# 本地安装与服务

Alu Dock 使用一个本机 npm 安装和一个 `systemd --user` Host Service。

## 位置

```text
~/.local/share/alu-dock/
~/.local/bin/aludock
~/.config/systemd/user/alu-dock.service
```

Host 和 Worker 从安装包自己的依赖加载 Agent runtime，不调用 `$PATH` 中的全局 Pi。生成的 user unit 只保存 Host 启动所需的固定 Node、CLI、HOME 和最小可执行 PATH，不固化安装命令当时的语言版本、npm PATH 或开发环境，也不替 Extension source 凭据文件。每个 Worker 在启动时从用户登录 shell 和自己的 workspace 独立取得开发环境。更新 Alu Dock 不删除 catalog 或 Agent session 文件。

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

替换 Host 不会迁移或重放未完成的内存状态和副作用。

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

普通 `aludock`、`-c`、`new` 和 `attach` 只连接已有 Host，不会安装、启动或重启 service。`uninstall` 只删除 Alu Dock 生成的 unit，不删除 catalog 或 Agent sessions。

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
