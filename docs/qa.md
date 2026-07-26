# Alu Dock 测试路由

## 先选最窄门禁

| 改动 | 首选检查 |
|---|---|
| Agent map / Markdown only | `git diff --check` + 手动验证链接/路径 |
| DTO、parser、pure reducer | `npm run check -- --pretty false` + 对应focused test |
| Protocol/Client/Host request | `control-protocol`, `dock-control`, `cli-cross-client` |
| Catalog/Registry | `catalog-transactions`, `durable-catalog-store`, `durable-registry` |
| ManagedInstance mutation | `managed-instance`, `operation-ledger` |
| Pi adapter / Worker IPC | 对应Pi unit fixture + `worker-protocol` + no-model-call real双Worker smoke |
| Pi dependency cohort | 跨版本breaking notes + exact pins/lockfile + 完整代码门禁 + no-model real Pi/PTY；目标model smoke另行授权 |
| TUI projection/layout | 对应pure TUI test + PTY at 80×24 and 120×40 |
| Session replacement/tree | generation/history tests + Pi tree/reopen real tests |
| Managed lifecycle | subprocess SIGTERM/SIGKILL tests；必要时唯一临时user unit |
| Local install / service code | `local-install`, `user-service`；真实安装需另行授权 |

测试由TypeScript编译后用Node test runner执行。Focused示例：

```bash
npm run build
node --test dist/test/control-protocol.test.js dist/test/dock-control.test.js
```

不要为每个字段重复完整build/test/audit；完成一个cohesive slice后统一运行。

## 常用检查

按改动选择检查，不把它们串成固定的发布流水线：

```bash
npm run check -- --pretty false   # 类型和编译边界
npm test                          # 改动跨越多个模块时再跑完整测试
git diff --check                 # 文本与补丁格式
```

改 Pi 依赖时再运行 `npm audit` 并核对 exact pins；改 runtime 边界时再检查 TUI、Core 和 Control 没有直接导入 Pi SDK。`npm run build` 会先清理 `dist`。

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
test/worker-protocol.test.ts
test/pi-workers-real.test.ts
test/pi-stage3-real.test.ts
test/pi-reopen-real.test.ts
test/pi-tree-hooks-real.test.ts
test/pi-tree-real.test.ts
test/pi-extension-ui-adapter.test.ts
test/pi-extension-ui-real.test.ts
test/pi-tool-result-normalizer.test.ts
test/pi-network.test.ts
```

Real Pi tests不得调用model；它们验证public API、session文件、resource loading、replacement与hooks。Worker real gate还必须验证distinct PID/cwd、reverse Host identity capability、单Worker loss隔离、stuck dispose的process-group回收与Host IPC loss后的orphan watchdog。

辅助脚本：

```text
scripts/sdk-smoke.ts             # 显式provider/model调用 smoke；只在任务授权时运行
scripts/tui-render-benchmark.ts  # conversation delta/tool render CPU benchmark
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

## TUI 手工检查

改动 TUI surface 时，由实现者亲自检查与改动相关的场景：

- 80×24与120×40；
- long cwd/name、multiline input、tool output、tree/picker/dialog；
- resize、scroll、detach、signal；
- Hub alternate-screen click/wheel cleanup与Work terminal-native selection/scrollback隔离；
- 无颜色、ANSI 16/256环境；
- idle时无不必要animation timer或持续重绘。

截图或文字记录只能辅助检查，不能替代真实PTY判断。

## 本地安装

`npm run install:local` 不运行测试。修改安装或 service 代码时运行 `local-install`、`user-service` focused 测试；其他检查按本文件前面的改动路由选择。

只有用户明确要求时才从 managed Host 外执行安装。命令和常见问题见 [`docs/local-install.md`](local-install.md)，不要擅自追加 `--replace-active`。
