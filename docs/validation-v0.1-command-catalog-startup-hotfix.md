# V0.1 真人启动 command catalog 回归复盘

日期：2026-07-15

## 结论

真人启动错误：

```text
Command catalog unavailable: commands is not deterministically sorted
```

**不是遗留进程。** 当时监听进程 PID `2841245` 的 `dist/src/cli.js` 与 `dist/src/pi/pi-runtime-host.js` 均在 12:46重新构建，晚于当前 `94484e0` commit；cwd、Node和 socket owner也都指向当前仓库。

这是生产数据形态触发的 producer/validator排序合同不一致。

## 根因

Host使用逐字段 comparator：

1. command name；
2. source kind/package/path；
3. description；
4. argument completion flag。

Protocol client却把部分字段用 NUL拼接成一个字符串，再对复合字符串调用 `localeCompare()`。NUL不是可靠的 collation separator，且 locale collation不保证“拼接比较”等价于“字段逐项比较”。

本机真实 39 项 command catalog中至少三组被误判：

- `chain` / `chain-prompts`；
- `parallel` / `parallel-cleanup`；
- `run` / `run-chain`。

例如 producer正确判断 `"chain" < "chain-prompts"`，但 NUL复合键的 `localeCompare()` 返回相反结果。

## 为什么原门禁漏过

1. Protocol parser测试只有单条 command，无法触发相邻排序验证。
2. Pi adapter测试使用 `safe`、`safe:1` 等直接 runtime结果，没有把同一批数据送入 wire parser。
3. PTY delayed runtime只返回单个 `fixture` command。
4. “真实 Pi Stage 3 smoke”验证了 extension lifecycle、settings、resources、session replacement与 compaction，但没有调用 command catalog。
5. 因而测试覆盖了代码层和真实 Pi层，却没有覆盖“真实资源分布经 Host producer再经 DockClient validator”的组合边界。

之前把该门禁概括为完整真实 Stage 3 startup证据并不严谨；现已收紧文档与发布合同。

## 修复

- 在 `src/core/config-projection.ts` 定义 locale-independent UTF-16 code-unit canonical comparators；
- command/tool/resource/diagnostic producer与 wire validator共用同一 comparator，不再复制排序字段或构造 NUL复合键；
- validator现在校验完整 canonical tuple，而不只是部分 identity字段；
- 未改变 closed DTO、capability或 runtime事务语义。

## 回归补强

- Protocol：固定 `chain/chain-prompts`、`run/run-chain` 及 tool/resource/diagnostic prefix形态，并确认逆序仍 fail closed；
- DockClient/Host integration与真实 PTY启动：delayed runtime默认返回 prefix/hyphen command对；
- 真实 Pi 0.80.6：temporary extension注册四个真实 command，并把 adapter结果送入正式 protocol parser；
- 阶段 3.6 post-deploy smoke：必须使用已发布 binary和真实本机 global/project resources，经 DockClient读取 commands/resources/tools/settings，不能再以 direct runtime call替代启动证据。

## 门禁结果

- TypeScript：PASS；
- full clean build/tests：**147/147 PASS**；
- 真实 Pi no-model-call smoke：PASS；
- PTY startup/workflow：PASS；
- audit high：0 vulnerabilities；
- diff/import/thin-TUI：PASS；
- 修复后当前本机真实 39-command catalog经完整 DockClient解析：PASS。

## 流程改进

新增 `docs/dogfood-deployment.md` 和阶段 3.6。后续阶段完成必须区分：

1. synthetic/code gate；
2. release artifact gate；
3. systemd service readiness；
4. 真实安装资源 post-deploy startup gate；
5. 真人 SSH dogfood。

只有 1–4 都通过才声明“可交给真人启动测试”。
