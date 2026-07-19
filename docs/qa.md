# Alu Dock 测试路由

## 先选最窄门禁

| 改动 | 首选检查 |
|---|---|
| Agent map / Markdown only | `git diff --check` + 手动验证链接/路径 |
| DTO、parser、pure reducer | `npm run check -- --pretty false` + 对应focused test |
| Protocol/Client/Host request | `control-protocol`, `dock-control`, `cli-cross-client` |
| Catalog/Registry | `catalog-transactions`, `durable-catalog-store`, `durable-registry` |
| ManagedInstance mutation | `managed-instance`, `operation-ledger` |
| Pi adapter | 对应Pi unit fixture + no-model-call real Pi smoke |
| Pi dependency cohort | 跨版本breaking notes + exact pins/lockfile + 完整代码门禁 + no-model real Pi/PTY；目标model smoke另行授权 |
| TUI projection/layout | 对应pure TUI test + PTY at 80×24 and 120×40 |
| Session replacement/tree | generation/history tests + Pi tree/reopen real tests |
| Managed lifecycle | subprocess SIGTERM/SIGKILL tests；必要时唯一临时user unit |
| Release code | full gate + authorized immutable deploy gate |

测试由TypeScript编译后用Node test runner执行。Focused示例：

```bash
npm run build
node --test dist/test/control-protocol.test.js dist/test/dock-control.test.js
```

不要为每个字段重复完整build/test/audit；完成一个cohesive slice后统一运行。

## 完整代码门禁

```bash
npm run check -- --pretty false
npm test
npm audit --audit-level=high
git diff --check
```

同时检查：

```bash
# 生产/测试不得使用Pi private subpath
! rg '@earendil-works/pi-coding-agent/' src test scripts

# TUI不得持有Pi runtime构造API
! rg 'AgentSession|createAgentSession' src/tui

# 仓库不得重建project settings guard
test ! -e .pi/settings.json
```

`npm run build`必须先删除`dist`并生成clean build；当前`package.json`的`build`脚本已负责该动作。

## 按模块定位测试

### Control / CLI

```text
test/control-protocol.test.ts
test/dock-control.test.ts
test/cli-cross-client.test.ts
test/cli-help.test.ts
test/cli-list.test.ts
test/operation-ledger.test.ts
test/project-trust.test.ts
```

### Catalog / durable Host

```text
test/catalog-transactions.test.ts
test/durable-catalog-store.test.ts
test/durable-registry.test.ts
test/durable-host-process.test.ts
test/managed-mode.test.ts
test/ensure-host.test.ts
```

### Core / Pi runtime

```text
test/managed-instance.test.ts
test/pi-runtime-host.test.ts
test/pi-stage3-real.test.ts
test/pi-reopen-real.test.ts
test/pi-tree-hooks-real.test.ts
test/pi-tree-real.test.ts
test/pi-extension-ui-adapter.test.ts
test/pi-extension-ui-real.test.ts
test/pi-tool-result-normalizer.test.ts
test/pi-network.test.ts
```

Real Pi tests不得调用model；它们验证public API、session文件、resource loading、replacement与hooks。

辅助脚本：

```text
scripts/sdk-smoke.ts             # 显式provider/model调用 smoke；只在任务授权时运行
scripts/tui-render-benchmark.ts  # conversation delta/tool render CPU benchmark
scripts/athena-smoke.ts         # released DockClient installed-resource smoke
```

### TUI

```text
test/tui-conversation.test.ts
test/tui-ux-state.test.ts
test/history-pagination.test.ts
test/queue-restoration.test.ts
test/session-tree.test.ts
test/fixtures/pty-tui-driver.py
```

## 人类surface门禁

在请求用户验收前，由实现者亲自检查：

- 80×24与120×40；
- long cwd/name、multiline input、tool output、tree/picker/dialog；
- resize、scroll、detach、signal；
- Hub alternate-screen click/wheel cleanup与Work terminal-native selection/scrollback隔离；
- 无颜色、ANSI 16/256环境；
- idle时无不必要animation timer或持续重绘。

截图或文字receipt只能记录证据，不能替代真实PTY判断。

## Managed release门禁

仅在用户明确授权deployment后执行：

1. clean committed HEAD完成完整代码门禁；
2. immutable release build；
3. 默认确认无active instance；
4. switch/restart后核对MainPID、V2 hello与新hostEpoch；
5. 使用released DockClient读取commands/resources/tools/settings/tree；
6. 检查journal severe errors；
7. 验证rollback-forward并写immutable receipt。

验证证据记录在Kanban、相关commit和immutable release receipt中；仓库不新增per-slice validation文档。相关gate通过后创建honest focused commit。
