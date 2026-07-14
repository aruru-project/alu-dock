# 阶段 3.5 验证记录：真人可用薄 TUI

日期：2026-07-14  
Pi SDK / pi-tui：0.80.6  
状态：实现与 deterministic 验证通过，等待真人真实使用反馈

## 产品调整

原先的 `serve → create → JSON receipt → prompt/events` 能证明控制面，却不能作为真人 V0。阶段 3.5 将机器接口保留为底层，同时把无参数 `alu-dock` 改为主入口：自动确保后台 Host、按 cwd 创建或重连实例，并进入薄 TUI。

这里不复刻 stock Pi TUI。TUI 仍是 Unix-socket 客户端，不直接持有 Pi SDK session，因此 detach 不影响实例所有权。

## 已实现

- `alu-dock`：自动启动 detached Host；零实例时创建、单实例时重连、多实例时选择。
- `alu-dock new` / `alu-dock attach`：明确创建或接入。
- `/model` 使用选择器列出 Pi `ModelRegistry.getAvailable()`（含已配置认证的本地 `models.json` 模型）；也支持 `/model PROVIDER/MODEL`。
- `/thinking [LEVEL]` 查看或设置当前模型可用 thinking level；模型/thinking 只在 idle 时切换并写回结构化 snapshot/event。
- 近期事件 replay + live follow。
- 用户消息、assistant text delta/完成消息、tool 摘要、错误和状态行。
- Enter 自动 prompt/steer；`/follow`、`/steer`、`/status`、`/detach`、`/stop`。
- Ctrl+D 或空编辑器 Ctrl+C detach；Host/instance 继续运行。
- slash command 和文件路径补全、IME-aware editor。
- TUI 输出过滤终端控制字符。
- 后台日志写入 socket 同目录 `host.log`。

## 自动验证

```text
npm run check   PASS
npm test        PASS — 31 tests
npm audit --audit-level=high   PASS — 0 vulnerabilities
git diff --check   PASS
```

新增 deterministic 覆盖：

- accepted prompt 产生有界 `message.submitted` event，供重连恢复用户消息；
- replay/live assistant delta 合并为可读消息；
- tool lifecycle 投影；
- event truncation 提示；
- terminal control character 过滤与严格行宽；
- idle 模型列表/切换、thinking 切换，以及 running 时明确 `instance_busy`。

## 无模型人工式 PTY smoke

使用 delayed runtime fixture 和两个独立伪终端完成：

1. 无参数 TUI 创建实例，`/detach` 后进程正常退出；
2. JSON `list` 证明同一实例仍为 `active/running`；
3. 第二 TUI `attach` 同一实例并 `/stop`；最终为 `stopped/aborted`；
4. 运行中输入 `human hello`，Host 记录 `message.submitted`，TUI 展示用户消息后 detach；
5. 两个活动实例时显示选择器并接入所选实例；
6. 独立验证 auto-start 启动后台 Host、ping 成功，SIGTERM 后 socket 正常清理；
7. idle fixture 通过 `/model fixture/local` 和可视选择器切模，再以 `/thinking high` 切换 thinking；重连 snapshot 与 `model.changed` / `thinking.changed` events 一致。

证据目录：

- `/tmp/alu-dock-tui-pty-pEhxlD`
- `/tmp/alu-dock-tui-input-IxEYIv`
- `/tmp/alu-dock-tui-select-hv59Rj`
- `/tmp/alu-dock-autostart-Pr8miU`
- `/tmp/alu-dock-tui-model-9mwhQr`
- `/tmp/alu-dock-tui-model-picker-zEUaUS`

以上均未调用真实模型。

## 等待真人发现的边界

- 长输出、中文输入、终端 resize 和实际 tool stream 的阅读体验；
- plain Enter 在运行中自动 steer 是否符合直觉；
- 多实例选择和 cwd 自动重连是否足够自然；
- 哪些 Pi slash command / Extension UI 是下一步真正高频需求。

这些不再通过更多假设性 reviewer 阻塞；由真实使用反馈决定下一轮。
