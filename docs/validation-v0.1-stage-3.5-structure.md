# V0.1 阶段 3.5：轻度结构重构与工程规范验证

日期：2026-07-14

## 结论

阶段 3.5 已完成行为保持的轻度重构，并新增项目根 `AGENTS.md`。本阶段没有改变 wire schema、advertised capability、Host owner、catalog transaction、runtime generation或 TUI功能面，也没有提前实现阶段 4–6。

## 模块拆分

### Core

新增 `src/core/instance-dto.ts`：

- 集中 closed instance snapshot、event map、cursor、history、receipt和 JSON DTO；
- 不持有 Pi runtime object；
- `ManagedInstance` 保持兼容 re-export，同时回归 lifecycle/admission/transaction facade职责。

`src/core/managed-instance.ts` 从约 2570 行降至约 2450 行。它仍然较大，因此 `AGENTS.md` 明确后续只允许按职责继续提取纯 reducer/projection，不允许把 protocol/TUI逻辑重新塞回。

### Control

新增 `src/control/session-command-service.ts`：

- 统一 `session.switch/new/name/compact/reload` 的 operation ledger、target trust和 runtime ambiguity语义；
- `DockHost` 只识别 capability request并委托 service；
- socket/hello/streaming与 session业务执行不再混在同一 switch分支。

`src/control/dock-host.ts` 从约 717 行降至约 680 行。

### Pi adapter

新增 `src/pi/pi-settings-adapter.ts`：

- 集中 exhaustive setting projection、source attribution、effective-value校验、public setter dispatch和 settings error投影；
- 保留 setter → flush → drain边界由 `PiRuntimeHost` 编排；
- 继续只使用 Pi包根公开 API。

`src/pi/pi-runtime-host.ts` 从约 914 行降至约 817 行，主要保留 runtime/session/replacement/resource职责。

### TUI

新增：

- `src/tui/settings-controls.ts`：setting value formatting、typed command parsing、choice和 autocomplete；
- `src/tui/snapshot-projection.ts`：live event → client snapshot纯归约。

`src/tui/dock-tui.ts` 从约 1329 行降至约 1136 行，继续负责 TUI组装和用户 workflow；纯 setting/snapshot逻辑不再内嵌。测试改为直接导入对应纯模块。

## `AGENTS.md` 工程合同

根 `AGENTS.md` 已冻结：

- 产品边界和 1.0 前绿地规则；
- cli/control/core/runtime-port/Pi-adapter/TUI 的依赖方向与模块职责；
- Host唯一 owner、closed DTO、generation/cursor、trust、catalog commit、effect_unknown、binary/terminal安全等不变量；
- Pi包根公开 API和 settings原生 flush语义；
- cohesive slice实现、一次统一门禁、尽早 SSH dogfooding 的任务流程；
- pure/unit、Host integration、real Pi、PTY和 replacement分层测试规范；
- 单写者、看板更新、validation文档和阶段边界要求。

规则强调“按 capability职责拆分”，而不是机械追求每个 setting一个文件或仅以行数评价模块。

## 回归门禁

```bash
npm run check -- --pretty false
npm test
npm audit --audit-level=high
git diff --check
```

结果：

- TypeScript clean build：PASS。
- 全量测试：**146/146 PASS**。
- 真实 Pi Stage 3 lifecycle/settings/compaction smoke：PASS（包含在全量测试）。
- 真实 PTY Stage 2/3 workflows：PASS（包含在全量测试）。
- audit high：0 vulnerabilities。
- diff/import/package-root/thin-TUI gates：PASS。
- `.pi/settings.json`：未修改。

## 明确未做

- 没有拆改 Protocol V2 schema或 capability名称；
- 没有改变 `ManagedInstance` FIFO、catalog commit或 replacement事务；
- 没有建设 extension interaction lease/UI broker；
- 没有建设 systemd、durable catalog、reopen；
- 没有建设 tree/fork/clone；
- 没有为了减少行数把紧密状态机拆成互相回调的碎片。

下一工程入口为阶段 4 Extension UI与当前扩展兼容。
