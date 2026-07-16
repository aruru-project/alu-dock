# Dogfood 发布与部署合同

状态：阶段 3.6 冻结发布合同；阶段 5 durable catalog/reopen/service lifecycle与阶段 6 `session.tree.v1`均继承全部可追溯发布要求。

## 目标

阶段性提交完成后，开发者和真人验收都从同一份已发布 artifact 运行：

```bash
alu-dock
```

不再通过 checkout 中的 `npm run cli` 判断已发布行为，也不再依靠无法追踪版本的 detached Host。源码 checkout仍可用于单元、PTY和 custom socket开发测试。

## 固定布局

```text
/home/luziyi/release/alu-dock/
├── releases/
│   └── <UTC timestamp>-<12-char git SHA>/
│       ├── dist/src/
│       ├── dist/scripts/
│       ├── node_modules/
│       ├── package.json
│       ├── package-lock.json
│       └── RELEASE.json
├── current -> releases/<release-id>
├── receipts/
│   ├── <release-id>.json
│   └── <failed-release-id>.failed.json
└── bin/alu-dock

~/.local/bin/alu-dock -> /home/luziyi/release/alu-dock/bin/alu-dock
~/.config/systemd/user/alu-dock.service
```

规则：

- release目录创建完成后不可原地修改；新版本创建新目录；
- `current` 只通过 same-filesystem临时 symlink + atomic rename切换；
- launcher和unit的ExecStart写入部署时`process.execPath`绝对路径，不依赖user manager继承PATH；generated unit另显式构造extension subprocess PATH：Node所在bin、`~/.local/bin`和标准系统bin，既不继承任意shell PATH，也保证同一安装的stock `pi`可被`pi-subagents`发现；
- artifact至少记录 commit、release ID、构建时间、Node、Dock/Pi版本及 gate摘要；
- 不从未提交或 dirty working tree发布；不把 repository `node_modules` 直接当作 release依赖；
- 回滚只切回完整旧 release，不把两个 release的 `dist`/dependencies混用。

## Systemd baseline

`alu-dock.service` 使用默认 private Unix socket和 journal：

- `Type=exec`；
- `ExecStart=<absolute-node> /home/luziyi/release/alu-dock/current/dist/src/cli.js serve --managed`；
- unit显式设置`ALU_DOCK_MANAGED=1`、清空继承的`ALU_DOCK_SOCKET`，并设置不含空项/相对项的deterministic PATH（部署Node bin优先，其后`~/.local/bin`与标准系统目录）；
- `RuntimeDirectory=alu-dock`、mode `0700`，socket为 `$RUNTIME_DIRECTORY/dock.sock`、mode `0600`；
- `StateDirectory=alu-dock`、mode `0700`，durable catalog为 `$STATE_DIRECTORY/catalog.json`、mode `0600`；
- `WorkingDirectory=%h`、`UMask=0077`、`KillMode=mixed`；
- `Restart=on-failure`、`RestartSec=2s`，manual stop不自动重启；
- `TimeoutStartSec=15s`、`TimeoutStopSec=15s`，后者大于 Host 12s有界 drain；
- stdout/stderr进入 user journal，不再写 `host.log`。

常用诊断：

```bash
systemctl --user status alu-dock.service
journalctl --user -u alu-dock.service -n 200 --no-pager
journalctl --user -u alu-dock.service -f
```

User manager整体为 degraded不构成失败；只判定 `alu-dock.service` 本身。Installer检查 linger但不修改机器 policy。应用ready必须同时满足V2 hello、完整managed capability集合（包括`catalog.maintenance.v1`与`session.tree.v1`）和hello PID=`MainPID`；restart还要求新`hostEpoch`。

显式管理命令：

```bash
alu-dock service install [--now]
alu-dock service start
alu-dock service restart
alu-dock service status
alu-dock service logs [--lines 200] [--follow]
alu-dock service stop
alu-dock service uninstall
```

只有这些命令管理unit。`open/new/attach`只做bounded连接等待，不调用systemctl，也不fork detached Host。`uninstall`只移除Alu Dock生成且带marker的unit，不删除catalog或Pi session。

仓库发布命令：

```bash
# 首次从过渡期 detached Host迁移；仍会先拒绝任何 active instance
npm run deploy:dogfood -- --replace-unmanaged

# 后续阶段发布
npm run deploy:dogfood
```

`--allow-active` 是明确接受中断当前 runtime的紧急开关，不得作为日常默认参数。发布器不会自动执行模型或扩展 side effect。

## 发布事务

一次阶段发布必须依次执行：

1. 确认 HEAD已提交、working tree clean，记录 commit；
2. 执行 TypeScript、clean build、全量 tests、audit、diff/import/package-root门禁；
3. 创建 staging release并安装 lockfile固定的 production dependencies；
4. 对 staging entry执行离线加载检查；
5. 查询当前 Host；存在 active instance/run时默认停止发布，要求用户先正常收口或明确授权 disruptive restart；
6. 完成 release目录后原子切换 `current`；
7. `daemon-reload`，enable/restart unit；首次迁移若存在 unmanaged Host必须显式授权并先 SIGTERM等待退出，绝不直接 unlink其 live socket；
8. bounded等待 V2 hello，验证 hello PID等于 unit `MainPID`，restart时验证 `hostEpoch` 已变化；
9. 使用**已发布 launcher和真实本机资源**执行 post-deploy smoke；
10. 写部署回执。任一步失败，切回旧 `current`、restart旧 unit并报告 journal；不得删除 Pi sessions或未来 catalog证据。

首次安装没有可回滚 release时，失败必须停住 unit并保留 staging/release证据。

## Post-deploy smoke

Smoke不能只做 `ping`，也不能只加载合成 extension。它至少要：

- 通过 release `DockClient` 连接 service；
- 在仓库 cwd创建临时实例，走正常 project trust；
- 读取并解析 commands、resources、tools、settings、snapshot和revision-bound session tree；
- hello必须advertise `session.tree.v1`，tree revision中的generation必须与snapshot一致；
- command catalog必须覆盖真实 global packages/extensions/skills/prompts；
- 校验 prefix/hyphen命令组合，例如已安装时的 `chain`/`chain-prompts`、`run`/`run-chain`；
- 确认 closed projection不含 handler、function、binary或 base64；
- 正常 stop临时实例；
- 不调用模型、不执行扩展 command/tool side effect。

只有 synthetic tests与该真实安装 smoke同时通过，才允许声明“启动门禁通过”。真实资源集合会变化，因此 smoke校验不冻结完整命令清单，只冻结 schema、canonical ordering、安全边界和已存在关键组合的相对顺序。

## 日常与开发入口

- `alu-dock`：唯一真人/dogfood入口，连接 managed service；service不可用时给出 unit/journal诊断，不静默 fork detached Host。
- `npm run cli`、custom `--socket`：checkout开发入口；其结果不能代替 release验证。
- 阶段完成：先 commit和gate，再发布；发布失败不把卡片阶段标成“已部署”。
- 阶段中间：除非修复阻断 dogfood 的 hotfix，不频繁覆盖 release。

## 阶段 5 durable restart语义

Managed Host只使用严格closed schema-1 catalog。每次startup在ready前先取得私有socket ownership，再load/validate并atomic reconcile；prior-epoch `active|stopping` 只归一为 `host_lost`，已有explicit stop intent归一为`stopped`，绝不构造runtime或重放旧prompt/queue/tool effect。Corrupt/future/wrong-owner/symlink catalog保留原证据并使unit启动失败。

用户可对`host_lost|runtime_error`记录显式reopen：先验证真实current-user session file与canonical cwd/project trust，再通过公开`SessionManager.open()`创建fresh runtime transaction，保持Dock ID/createdAt、generation +1。Pi JSONL仍是conversation context权威；catalog不是queue或event log。

发布器仍默认拒绝有active instance的restart。只有用户明确授权时才使用`--allow-active`；这会中断旧runtime，但下一epoch会保留可显式reopen的catalog identity，不会自动继续工作。
