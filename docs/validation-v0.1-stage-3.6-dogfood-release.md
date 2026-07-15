# V0.1 阶段 3.6：Dogfood release 与 managed service基线

日期：2026-07-15

## 结论

阶段 3.6 **PASS**。真人默认入口现为：

```bash
alu-dock
```

该命令解析到 `~/.local/bin/alu-dock`，再进入 `/home/luziyi/release/alu-dock` 的 stable launcher。默认 socket由 enabled `systemd --user` unit唯一持有；managed入口不会在 service不可用时静默回退为 detached Host。

本阶段没有实现或声称 durable catalog/reopen。Service restart仍会清空当前内存 Dock instances；Pi session JSONL保留，但自动 reconcile与显式 reopen仍属于阶段 5。

## 代码交付

Commit：

- `5aa58b0 fix: align canonical catalog ordering`；
- `7411306 feat: add managed dogfood release baseline`。

新增：

- `src/deployment/dogfood-release.ts`：release layout、launcher与 unit纯生成器；
- `scripts/deploy-dogfood.ts`：clean HEAD gate、immutable artifact、atomic current、service切换、rollback、receipt；
- `scripts/dogfood-smoke.ts`：使用 release DockClient和真实本机 resources完成 no-model-call startup smoke；
- `test/dogfood-release.test.ts`、`test/ensure-host.test.ts`；
- `docs/dogfood-deployment.md`。

`src/control/ensure-host.ts` 新增 managed边界：release launcher设置 `ALU_DOCK_MANAGED=1` 后，只等待 service readiness并给出 unit/journal诊断，不 spawn detached进程。Checkout `npm run cli` 暂保留 dev fallback，阶段 5再彻底移除。

## 发布布局

首次成功 release：

```text
/home/luziyi/release/alu-dock/
├── releases/20260715T052652Z-7411306c8bfa/
├── current -> releases/20260715T052652Z-7411306c8bfa
├── bin/alu-dock
└── receipts/20260715T052652Z-7411306c8bfa.json
```

Artifact使用独立 `npm ci --omit=dev` 安装的 lockfile production dependencies，没有复用 checkout `node_modules`。`RELEASE.json`记录完整 commit、Node、Dock/Pi版本与构建时间。

Unit：

- `~/.config/systemd/user/alu-dock.service`；
- enabled、`active/running`；
- `Type=exec`；
- 绝对 NVM Node与 absolute `current/dist/src/cli.js`；
- `RuntimeDirectory/StateDirectory=alu-dock`、mode `0700`；
- `UMask=0077`；
- `Restart=on-failure`；
- SIGTERM有界 graceful shutdown；
- stdout/stderr只进入 user journal。

## 自动化门禁

发布器在切换前重新执行完整门禁：

- TypeScript：PASS；
- clean build + tests：**151/151 PASS**；
- 真实 Pi 0.80.6 no-model-call lifecycle/command smoke：PASS；
- 真实 PTY：PASS；
- audit high：0 vulnerabilities；
- private import、thin-TUI、package-root exports、clean tree与 diff：PASS。

## 首次迁移与 readiness

首次发布显式使用 `--replace-unmanaged`。发布器确认旧 Host无 active instance后：

1. SIGTERM旧 detached Host，不 unlink live socket；
2. 原子切换 `current`；
3. daemon-reload + enable/start unit；
4. 等待 V2 hello；
5. 验证 hello PID等于 unit `MainPID`；
6. 验证 `hostEpoch` 已改变；
7. 执行 release-owned真实资源 smoke。

成功部署时：

- MainPID：`2847376`；
- hostEpoch：`544cdd9c-aed6-4e46-a1a4-877d375edd2f`；
- command catalog：39；
- resources：20；
- tools：18；
- settings：24；
- `chain/chain-prompts`、`run/run-chain` canonical ordering：PASS。

完整证据位于 release receipt；后续 controlled restart/rollback会产生新 PID/epoch，receipt仍保留部署时事实。

## 真实运行门禁

### Stable launcher / PTY

从 `command -v alu-dock` 启动真实 PTY，完成 initial projection、resize和 detach，退出码 0；没有再次出现 command catalog错误。测试创建的 instance随后正常 stop。

### Active instance拒绝

创建真实 active instance后直接执行发布器，发布在任何 build/switch/restart前拒绝：

```text
Deployment refused: current Host has 1 active instance(s)
```

清理测试实例后 service保持健康。

### Manual stop语义

`systemctl --user stop alu-dock.service` 产生 `host.stopping` → `host.stopped`，unit保持 inactive，没有被 `Restart=on-failure`拉起；显式 start后得到新 epoch。Journal完整记录启动、SIGTERM drain、CPU和memory peak。

### 失败回滚

使用不存在的 post-deploy smoke cwd执行一次受控失败：

- candidate release构建并启动；
- released smoke fail closed：`Working directory does not exist`；
- 发布器退出 1并写 `.failed.json` receipt；
- `current`原子恢复到上一成功 release；
- old release被重新启动；
- hello PID重新匹配 MainPID且 epoch再次改变；
- Pi sessions与 release失败证据均未删除。

失败 receipt：

```text
receipts/20260715T053451Z-7411306c8bfa.failed.json
```

这验证了 switch后 smoke失败的真实 rollback路径，而非仅验证纯函数。

## 运维入口

```bash
alu-dock
alu-dock ping
systemctl --user status alu-dock.service
journalctl --user -u alu-dock.service -n 200 --no-pager
journalctl --user -u alu-dock.service -f
```

阶段提交后的发布命令：

```bash
npm run deploy:dogfood
```

默认禁止 active-instance restart；`--allow-active`只用于用户明确接受中断的紧急场景。

## 明确延后

- durable fsync/rename catalog；
- startup reconcile与 `host_lost/interrupted`归一；
- explicit reopen；
- `alu-dock service install/start/stop/restart/status/logs/uninstall`完整 CLI；
- 所有 checkout普通入口移除 detached fallback。

下一工程入口为阶段 4 Extension UI与当前七扩展兼容。
