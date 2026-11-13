# 给助手加一个本机工具

助手可以直接调用你自己的业务工具，不必为每次查询开一个子 Work。扩展只给她增加工具，不接管对话、提示词或回复循环；普通 Pi Work 的扩展配置不受影响。

## 添加、启停和配置

在官方客户端打开 **助手 → 设置 → 助手工具扩展**：

1. 添加一个标识，例如 `my-tools`。标识只用字母、数字、下划线和短横线，同一列表不能重复。
2. 填 **Main 所在机器**的绝对 `.mjs` / `.js` 路径，例如 `/home/me/tools/my-tools.mjs`。推荐 `.mjs`；`.js` 必须按 Node 的 ESM 规则加载（所在 package 的 `type` 是 `module`）。不能填客户端手机或另一台机器上的路径。
3. 在本项 JSON 配置中填写对象，例如 `{ "location": "home" }`，勾选启用并保存。
4. 等助手空闲，在她的对话命令中心执行 **刷新助手（Reload）**。聊天记录保留，下一轮使用刚加载的工具。

启停、修改配置、增加或移除项目都要保存后 Reload；保存本身不热换正在使用的工具。界面列出最近读到的加载状态；“当前注册的工具”及对话中的工具列表来自实际注册结果，扩展工具标为 `extension / 标识`。需要最新结果时点刷新。加载失败的扩展不注册，其他扩展和内置工具照常可用，修正后再 Reload。

配置存在 Main 助手服务的 SQLite `meta` 中；配对过的客户端可以读写。省略 `assistant.settings.set.extensions` 保留原列表，传数组整份替换，`[]` 表示不加载任何扩展。每项是：

```json
{
  "id": "my-tools",
  "module": "/home/me/tools/my-tools.mjs",
  "enabled": true,
  "config": { "location": "home" }
}
```

内置工厂用 `builtin:名称`，由随包 Worker 显式注册，不扫描本机目录。Main 的出厂设置启用 `builtin:web`，联网实现随 Dock 一起安装，不要求用户装过 Pi 或任何 Pi 扩展。没有运行时自动安装、下载或插件市场。

## 随包联网扩展

`builtin:web` 提供 `web_search`、`fetch_content`、`get_search_content`、`source_check`，具体列表遵循本项配置。实现复用固定版本 pi-web-access 的公开独立接口，通过 Pi 的独立 MCP 客户端库调用；它不是 Pi Agent，也不是另一份搜索引擎。

本项 JSON 配置使用 pi-web-access 的 `web-search.json` 格式。例如显式使用自己的 Exa 账户：

```json
{ "provider": "exa", "exaApiKey": "填写自己的密钥" }
```

空配置采用联网引擎的默认路由（支持无密钥的 Exa MCP），不保证服务可用性或免费额度；收费与权限以你选择的搜索服务为准。也支持你自己的 SearXNG 地址等配置。已有 Pi 联网配置可以复制到此处，但 Dock 不读取或改写你的 Pi 扩展安装。配置写入本项私人 dataDir 下的 `web-search.json`，不进入模型对话。

配置与启停保存后 Reload 生效。联网引擎作为此扩展拥有的固定本机服务运行，Reload/助手退出时关闭；内存中的搜索结果编号随它退出失效，不能当作永久记忆。尚需的来源和结论应保存在助手对话/记忆中。

独立接口不支持 Pi 专属的 curator、ChatGPT 登录复用、当前 Pi 模型搜索、网页问答模式、视频抽帧等能力；这里不宣称它们已经迁入。需要这些功能时仍可交给普通 Pi Work。公开配置说明见 [pi-web-access](https://www.npmjs.com/package/pi-web-access)。

## 最小扩展

保存为自己的 `my-tools.mjs`。无需导入 Pi 类型或 SDK：

```js
export default async function (context) {
  return {
    tools: [{
      name: "my_location",
      description: "Read the location selected in my local settings.",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      async execute(params, { callId, signal, onUpdate }) {
        signal.throwIfAborted();
        return {
          content: [{ type: "text", text: `Location: ${context.config.location ?? "not set"}` }],
          details: { found: context.config.location !== undefined },
        };
      },
    }],
    async dispose() {
      // Close clients, timers, subscriptions, or other resources you created.
    },
  };
}
```

这份示例只有一个静态查询，不执行命令，也不联系任何服务。返回的文字会交给模型并留在对话中；示例中的 `location` 是允许公开给模型的业务值，**不要换成密钥**。

## API

准确的 TypeScript 类型在 `src/assistant-agent/tool-extensions.ts`，JavaScript 扩展不需要导入它。

`default async function(context)` 返回 `{ tools, dispose? }`：

- `context.cwd`：助手的工作区。
- `context.dataDir`：`<cwd>/.assistant-extensions/<id>`。加载器创建这个目录；停用、移除或 Reload 不删除其中的数据。改变标识会使用另一处目录。
- `context.config`：只包含本项配置的副本，不含其他扩展的配置。允许 JSON 对象，沿 Dock 现有 JSON 传输限制校验，不截断配置。
- `context.notify(message, level?)`：在客户端通知主人，不添加一条聊天消息。`level` 是 `info` 或 `warning`。
- `context.confirm(title, message, signal)`：沿现有 Host 确认界面询问主人，返回 `Promise<boolean>`。删除等需要确认的操作只有返回 `true` 才能执行；把本次调用的 `signal` 传进去。取消或没有确认都不算授权。

每个工具有 `name`、`description`、`parameters` 和 `execute`：

- 名称只用字母、数字、下划线、短横线，不能与内置工具或已加载扩展重名。冲突时整个冲突扩展不注册，原工具不被替换。
- `parameters` 是 `type: "object"` 的 JSON Schema；说明和 schema 正常提供给模型，不能塞配置或凭据。
- `execute(params, { callId, signal, onUpdate? })` 返回 Promise。`params` 是这次调用的 JSON 参数；`signal` 随停止回复或扩展卸载取消。网络请求应把它传给 `fetch` 等底层调用，不自行无限重试。
- 结果 `{ content, details?, isError? }`：`content` 是 text/image 数组；文字是 `{type:"text",text}`，图片是 `{type:"image",data,mimeType}`，`data` 为 Base64。`details` 为 JSON 值，可供现有工具展示使用；它同样会保存在会话中，不能含凭据。失败可抛错，或返回 `isError: true`。
- `onUpdate(result)` 使用相同结果形状，提供执行中的更新。
- `dispose()` 在 Reload 和 Worker 正常结束时释放资源。工厂初始化中途抛错、还没返回对象时，由工厂自己清理已创建的资源。进程被强制终止时不能保证执行清理。

需要确认的工具执行体可以这样写：

```js
async execute(params, { signal }) {
  const confirmed = await context.confirm("删除这一项？", "删除后不能恢复。确认继续吗？", signal);
  if (!confirmed) return { content: [{ type: "text", text: "没有确认，未作修改。" }] };
  signal.throwIfAborted();
  // Perform the explicitly confirmed operation here, using signal where supported.
  return { content: [{ type: "text", text: "操作已完成。" }] };
}
```

## 信任边界和生命周期

这是用户信任的本机 JavaScript，和助手在同一个 Worker 进程里运行，**不是沙箱**。它有该进程的本机权限，能读取文件或访问网络；不要加载不可信代码，也不要把“API 没有给某个对象”当成安全隔离。工厂和工具必须及时完成并响应取消，不能阻塞 Node 主线程。

加载器不把 `config` 拼进工具说明、系统提示或聊天；内置 `assistant_memory` 的设置操作也只返回它负责的整理记忆模型。扩展作者仍须保证自己的说明、结果、更新和报错不泄露秘密。不要把秘密写进源码示例、工具 schema 或 `details`。已有对话中记录的业务输出不会因禁用扩展被删除。

Reload 会清理旧扩展，再重新执行入口模块，重读 Main 配置。Node 缓存的间接依赖不强制失效；修改依赖代码后可重启助手。加载器不为每个扩展另起 Work 或通用进程容器，也没有会话钩子、循环接管或后台重启平台。扩展如需自己的辅助进程（随包联网服务就是一例），必须自己负责关闭资源。

随包扩展只在 Worker 装配：`assistant-worker-entry.ts` 把 `builtin-extensions.ts` 的 `builtinAssistantExtensions` 传给 `createAssistantAgent`。向 map 增加 `web: factory` 即对应 `builtin:web`，Host 不导入这些模块。
