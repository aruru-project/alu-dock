# 给助手加工具、命令和 Skill

助手扩展有三种用途：工具交给模型调用；命令让主人从命令中心直接执行；Skill 是需要时再读的操作手册。它们复用助手现有的运行与界面能力，普通 Pi Work 的扩展配置不受影响。

## 添加、启停和配置

配置文件是 **Main 助手工作区的 `extensions.json`**，默认 `~/.aludock/assistant/extensions.json`。在 Main 上编辑它，等助手空闲后，从她的命令中心执行 **刷新助手（Reload）**。对话继续使用原来的记录。

文件是一个数组，例如：

```json
[
  { "id": "web", "module": "builtin:web", "enabled": true, "config": {} },
  {
    "id": "my-tools",
    "module": "/home/me/tools/my-tools.mjs",
    "enabled": true,
    "config": { "location": "home" },
    "skills": ["./manuals/my-tools"]
  }
]
```

- `id`：唯一标识，只用字母、数字、下划线和短横线。
- `module`：Main 所在机器上的绝对 `.mjs` / `.js` 路径。推荐 `.mjs`；`.js` 所在 package 须采用 ESM。不能填手机或另一台机器上的路径。
- `enabled`：是否加载本项。
- `config`：本项的 JSON 对象。扩展作者决定其中业务设置的含义。
- `skills`：可选手册文件或目录，相对路径从 `extensions.json` 所在目录计算。

没有配置文件时启用随包的 `builtin:web`；显式 `[]` 表示不加载扩展。坏文件会报错，不会暗中采用另一份配置。修改、启停、增删条目都在 Reload 后生效，不热换正在执行的工具。

**从 RC6/RC7 的旧配置升级**：助手服务把 SQLite `meta.tool_extensions` 的原始内容一次迁到这个文件，保留所有条目、参数和标识；原 `dataDir` 不变。若文件已经存在，以文件为准，旧内容保留为工作区内的 `extensions.sqlite-backup-*.json`。落盘成功后移除旧数据库键，之后只读取文件，不再双源回退。已有文件的加载不依赖记忆服务在线；只有文件尚不存在时，Worker 才等待旧配置迁移的就绪答复。

`aludock assistant:backup` 备份身份和记忆；工作区的 `extensions.json`、扩展代码及所需 `dataDir` 请另行备份，按含私人参数的文件保管。

官方客户端不再提供通用插件 JSON 编辑面板，`assistant.settings` 也不再读写 `extensions`。这是配置入口的收敛；扩展若需要日常业务设置，应设计名称、含义和校验清楚的界面。

加载结果可在命令中心的**她能用的工具**、命令列表和 **`/assistant-status`（查看助手运行详情）**中查看。正常加载不占聊天警告栏；加载问题显示一条短提醒，详细原因按需查看，工厂的原始异常留在本机日志。修正文件后 Reload。

## 最小扩展

保存为自己的 `my-tools.mjs`，无需导入 Pi 类型或 SDK：

```js
export default async function (context) {
  return {
    tools: [{
      name: "my_location",
      description: "Read the location selected in my local settings.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      async execute(params, { signal }) {
        signal.throwIfAborted();
        return {
          content: [{ type: "text", text: `Location: ${context.config.location ?? "not set"}` }],
        };
      },
    }],
    commands: [{
      name: "my-echo",
      description: "直接回显文字，不请求模型",
      argumentHint: "<任意文字>",
      execute(args, { signal }) {
        signal.throwIfAborted();
        return `收到：${args}`;
      },
    }],
    async dispose() {
      // Close clients, timers, subscriptions, or processes you created.
    },
  };
}
```

模型可调用 `my_location`；主人可在命令中心选择 `/my-echo`，或直接输入 `/my-echo 要回显的文字`。示例的 `location` 是允许给模型看的业务值，不要替换成密钥。

## API

准确类型位于 `src/assistant-agent/tool-extensions.ts`。工厂 `default async function(context)` 返回 `{ tools?, commands?, skills?, dispose? }`，至少声明工具、命令或手册之一。原来只返回 `tools` 和 `dispose` 的扩展继续可用。

### 工厂上下文

- `context.cwd`：助手工作区。
- `context.dataDir`：`<cwd>/.assistant-extensions/<id>`，由加载器创建。停用、移除和 Reload 不删除数据；改变标识会使用另一处目录。
- `context.config`：本项配置的副本，不含其他扩展配置。
- `context.models`：现有 SDK `Models` 的目录与认证读取子集，使用助手已接入 Main 的模型运行时，与助手当前聊天模型无关。见下节。
- `context.notify(message, level?)`：通知主人，不新增聊天消息；级别为 `info` 或 `warning`。
- `context.confirm(title, message, signal)`：沿 Host 的确认界面询问主人，返回 `Promise<boolean>`。只有返回 `true` 才执行需要确认的操作。

### 复用 Main 的模型目录与认证

`context.models` 的方法直接沿用 `@earendil-works/pi-ai` 的公开 `Models` 类型，不把 Worker、会话或模型运行时内部对象交给扩展：

| 方法 | 用途 |
|---|---|
| `getModels(providerId?)`、`getModel(providerId, modelId)` | 读取当前已加载的聊天模型目录，按指定通道选择，不要求切换助手的聊天模型。 |
| `getAvailable(providerId?, options?)` | 读取认证配置可用的模型。 |
| `checkAuth(providerId, options?)` | 检查认证配置的类型与来源，不为这个检查续期 OAuth。 |
| `getAuth(providerIdOrModel, options?)` | 取得本次请求的有效认证；按模型获取时也包含对应的静态请求头。认证读取、OAuth 续期仍交给 Main。 |
| `refresh(options?)` | 按需重新读取 Main 配置与目录；例如 `refresh({ allowNetwork: false, signal })`。普通查询不要求每次先刷新。 |

异步方法的 `options.signal` 可沿用工具或命令的取消信号。`getAuth` 返回 SDK 的 `AuthResult`，认证在 `result.auth` 下；通道没有配置认证时返回 `undefined`，解析或续期失败时拒绝。需要认证的业务请求应当时调用，不保存 token 或自行维护续期。

这是交给**可信本机扩展代码**的能力，不是给模型的新凭据工具。访问令牌可用于对应服务请求，但不要把整个认证结果、请求头或原始异常交给模型、用户结果或日志；只返回业务需要的数据和安全的处理说明。模型目录对象也可能带服务请求头，展示时只挑名称等必要字段。服务地址与认证用途由扩展核对，不能把一个通道的凭据随意转发到另一个地址。

命令和模型工具都可闭包使用同一个 `context.models`。本轮开放目录与认证读取，登录、登出、配置修改和推理调用不在这个扩展接口中；账号操作仍走 Main 原有登录入口，不建立第二套管理机制。供应商额度等业务请求与解释由扩展实现，Dock 核心不添加供应商专属查询。

### 模型工具

每个工具包含 `name`、`description`、`parameters` 和 `execute`：

- 名称只用字母、数字、下划线和短横线。工具名冲突时该扩展不注册，原工具不被替换。
- `parameters` 是 `type: "object"` 的 JSON Schema；说明和参数定义提供给模型。
- `execute(params, { callId, signal, onUpdate? })` 返回 Promise。网络调用应把 `signal` 传给底层请求。
- 结果 `{ content, details?, isError? }`：文字为 `{type:"text",text}`，图片为 `{type:"image",data,mimeType}`，`data` 是 Base64；`details` 是 JSON 值。最终结果会留在会话里。失败可抛错，或返回 `isError: true`。
- `onUpdate(result)` 使用相同结果形状，报告运行中的进度，不替代最终返回结果。

需要确认的工具可以这样写：

```js
async execute(params, { signal }) {
  const confirmed = await context.confirm("删除这一项？", "删除后不能恢复。确认继续吗？", signal);
  if (!confirmed) return { content: [{ type: "text", text: "没有确认，未作修改。" }] };
  signal.throwIfAborted();
  // Perform only the confirmed operation, using signal where supported.
  return { content: [{ type: "text", text: "操作已完成。" }] };
}
```

### 主人直接执行的命令

每条命令包含 `name`、`description`、可选 `argumentHint` 和 `execute(args, command)`：

- `name` 不带 `/`，字符规则与工具名相同。
- `args` 是原样的自由文本，不按 shell 参数拆解。
- `execute` 可返回字符串、空值或对应 Promise。字符串显示在命令结果区；空值显示完成提示。这条路径不请求模型，不写入聊天上下文。
- `command.signal` 随中止、卸载或关闭 Worker 取消。
- `command.notify(message, level?)` 在执行期间把信息关联到本条命令；级别为 `info`、`warning` 或 `error`。
- `command.confirm(title, message)` 使用本条命令的取消信号。返回 `false` 或收到取消时，扩展应停止，不继续执行需要确认的操作。
- 超过一秒会显示执行提示。命令中心可中止；有确认问题时可点**回答问题**进入原确认框，关闭命令面板本身不会中止命令。

命令不能覆盖助手内置命令、平台本地操作或已经注册的同名命令，例如 `assistant-status`、`dock-tools`、`reload`、`model`。平台名称共用 `src/shared/local-control-command-names.json`。冲突只拒绝那条命令并说明换名，保留扩展原有工具和其他有效命令；修正后 Reload，不留旧入口。

未知斜杠前缀仍按普通消息处理。命令只收文字参数，附带文件时会明确拒绝，不丢弃附件后偷偷执行。

### Skill 手册

本机扩展未在工厂或配置中声明 `skills` 时，默认发现**模块文件旁的 `skills/` 目录**；目录不存在不报错。这让已有的工具及其随包手册一起可用，不需要主人另填路径。这里只扫描手册，不发现或执行其他插件代码。

也可返回 `skills: ["./manuals/my-tools"]`，相对路径从**模块文件所在目录**计算；随包工厂返回绝对路径。配置项 `skills` 则从 `extensions.json` 所在目录计算。两种显式声明可并用；显式声明取代上述默认目录，空数组可关闭默认发现。

助手同时发现工作区 `.pi/skills`、工作区向上至仓库根的 `.agents/skills`，以及 Home 下的 `.aludock/skills` 和 `.agents/skills`。这些只加载 Skill 元信息，不导入整套 Pi 用户身份、AGENTS 或扩展宿主。

提示中提供名称、用途和文件读取入口，匹配任务时再读正文；启动、正常新回复和 Reload 都重新发现，索引未变时不重建提示。`disable-model-invocation` 遵循 SDK 的索引规则。坏手册路径只产生资源诊断，不卸掉已能用的工具或命令。客户端可在助手状态的 **已发现 Skills** 中打开手册正文；Agent 的读取记录保留实际文件来源。

发现和按需读取让模型具备遵循手册的条件；实际业务仍需验看是否按规则执行。

## 随包联网扩展

`builtin:web` 提供 `web_search`、`fetch_content`、`get_search_content`、`source_check`，列表遵循本项配置。它复用固定版本 pi-web-access 的独立接口，通过独立 MCP 客户端调用，不需要预装 Pi 扩展。

`config` 采用 pi-web-access 的 `web-search.json` 格式，例如：

```json
{ "provider": "exa", "exaApiKey": "填写自己的密钥" }
```

空配置采用引擎默认路由；可用性、权限和费用由所选服务决定。已有 Pi 联网配置可复制到此处，Dock 不改用户的 Pi 扩展安装。配置保存在本项私人 dataDir 的 `web-search.json`，不进入模型对话。Reload/退出会关闭该扩展拥有的服务，内存结果编号随之失效；需要长期保留的来源和结论应写入助手对话或记忆。

独立接口尚不支持 Pi 专属 curator、ChatGPT 登录复用、当前 Pi 模型搜索、网页问答模式及视频抽帧；这些仍可交给普通 Pi Work。配置说明见 [pi-web-access](https://www.npmjs.com/package/pi-web-access)。

## 信任和资源清理

扩展是用户信任的本机 JavaScript，运行在助手 Worker 中，有该进程的文件和网络权限，不是沙箱。工厂、工具和命令应及时完成并响应取消，不阻塞 Node 主线程。

加载器不把 `config` 拼入工具说明、提示或聊天。扩展作者也须避免把凭据放进说明、结果、更新、`details` 或报错。停用扩展不删除已有对话中的业务输出。

Reload 清理旧扩展并重执行入口模块；Node 缓存的间接依赖不强制失效，改依赖代码后可重启助手。`dispose()` 负责关闭自己创建的客户端、计时器和辅助进程；工厂在返回前失败时自行清理，进程被强制结束时不能依赖 `dispose()`。

随包工厂只在 Worker 内的 `builtin-extensions.ts` 装配。没有运行时自动下载、插件市场、会话钩子或循环接管接口。
