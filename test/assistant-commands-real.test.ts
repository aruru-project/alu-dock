import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import type { DockEvent } from "../src/core/instance-dto.js";
import { startNativeTeam, trustOnce } from "./support/native-team.js";
import { waitFor } from "./support/plan-goal-provider.js";

// #671: the owner runs an extension directly, through the same catalog, submit and UI paths as Pi
// commands. Only the loopback provider is fake; the extension, Host and independent Workers are real.
test("the owner runs an assistant extension command, sees its result, and Reload adopts renamed or disabled commands", { timeout: 60_000 }, async (context) => {
  const team = await startNativeTeam(context, ["coordinator"], { prefix: "alu-assistant-commands-", assistant: true });
  const module = join(team.root, "local-command.mjs");
  const legacy = join(team.root, "legacy-tools.mjs");
  const configFile = join(team.cwd, "extensions.json");
  const marker = join(team.root, "executed.json");
  const source = (name: string) => `import { writeFile } from "node:fs/promises";
    export default async function({ config, dataDir, cwd }) {
      return { commands: [{ name: ${JSON.stringify(name)}, description: "确定性本机回显", argumentHint: "<任意文字>",
        async execute(args, context) {
          if (args === "fail") throw new Error(config.secret);
          if (args === "confirm" || args === "cancel") {
            const approved = await context.confirm("确认本机操作", "只写隔离目录中的回显文件。");
            context.signal.throwIfAborted();
            if (!approved) return "没有执行本机操作。";
          }
          context.notify("本机命令开始");
          await writeFile(${JSON.stringify(marker)}, JSON.stringify({ args, cwd, dataDir, pid: process.pid }));
          return "本机回显：" + args;
        }
      }] };
    }`;
  await writeFile(module, source("local-echo"));
  await writeFile(legacy, `export default async function() { return { tools: [{ name: "legacy_local_tool", description: "Existing tools-only extension",
    parameters: { type: "object", properties: {} }, async execute() { return { content: [{ type: "text", text: "still available" }] }; }
  }] }; }`);
  const settings = [
    { id: "echo", module, enabled: true, config: { secret: "PRIVATE_COMMAND_ERROR" } },
    { id: "legacy", module: legacy, enabled: true, config: {} },
  ];
  await writeFile(configFile, JSON.stringify(settings));
  const client = await team.startHost();
  const assistant = await team.assistantWork();
  const events: DockEvent[] = [];
  const follower = await client.streamEvents(assistant.id, { onEvent: event => { events.push(event); } });
  context.after(async () => { follower.close(); await follower.done.catch(() => {}); });
  const notifications = (operationId: string) => events.filter((event): event is Extract<DockEvent, { type: "extension.notification" }> =>
    event.type === "extension.notification" && event.data.operationId === operationId).map(event => event.data);
  const handled = async (operationId: string) => waitFor(() => events.some(event => event.type === "command.handled" && event.data.operationId === operationId), `Command ${operationId} did not finish`);

  const catalog = await client.commands(assistant.id);
  assert.deepEqual(catalog.commands.map(command => command.name), ["assistant-status", "dock-tools", "local-echo"]);
  assert.deepEqual(catalog.commands.find(command => command.name === "local-echo"), {
    name: "local-echo", description: "确定性本机回显", argumentHint: "<任意文字>", argumentCompletions: false,
    source: { kind: "extension", package: "echo", path: module },
  });
  assert.deepEqual((await client.commands(assistant.id, "local-")).commands.map(command => command.name), ["local-echo"]);
  assert.ok((await client.tools(assistant.id)).tools.some(tool => tool.name === "legacy_local_tool"));

  const beforeDetails = (await client.conversationHistory(assistant.id)).entries;
  const detailsReceipt = await client.prompt(assistant.id, "/assistant-status", "auto", "assistant-details");
  assert.equal(detailsReceipt.receipt.kind, "extension_command");
  await handled("assistant-details");
  await waitFor(() => notifications("assistant-details").length > 0, "Assistant details did not reach the command console");
  const details = notifications("assistant-details").map(item => item.message).join("\n");
  assert.match(details, /滚动整理/);
  assert.match(details, /echo：已加载，0 个工具、1 个命令/);
  assert.match(details, /legacy：已加载，1 个工具、0 个命令/);
  assert.deepEqual((await client.conversationHistory(assistant.id)).entries, beforeDetails, "Reading runtime details keeps the conversation unchanged");

  const args = 'a  "b c"\n第二行';
  const receipt = await client.prompt(assistant.id, `/local-echo ${args}`, "auto", "local-first");
  assert.equal(receipt.receipt.kind, "extension_command");
  await handled("local-first");
  assert.deepEqual(notifications("local-first").map(item => item.message), ["本机命令开始", `本机回显：${args}`]);
  const executed = JSON.parse(await readFile(marker, "utf8"));
  assert.deepEqual({ ...executed, pid: undefined }, { args, cwd: team.cwd, dataDir: join(team.cwd, ".assistant-extensions", "echo"), pid: undefined });
  assert.ok(team.workerPids.includes(executed.pid) && executed.pid !== process.pid);

  await client.prompt(assistant.id, "/local-echo confirm", "auto", "local-confirm");
  await waitFor(async () => (await client.status(assistant.id)).activeInteraction?.method === "confirm", "The command did not ask the owner to confirm");
  await client.respondInteraction(assistant.id, undefined, (await client.status(assistant.id)).activeInteraction!.id, { method: "confirm", confirmed: true });
  await handled("local-confirm");
  assert.ok(notifications("local-confirm").some(item => item.message === "本机回显：confirm"));

  await client.prompt(assistant.id, "/local-echo cancel", "auto", "local-cancel");
  await waitFor(async () => (await client.status(assistant.id)).activeInteraction?.method === "confirm", "The cancellable confirmation did not open");
  await client.abortRestoreQueue(assistant.id);
  await handled("local-cancel");
  assert.equal((await client.status(assistant.id)).activeInteraction, undefined);
  assert.ok(notifications("local-cancel").some(item => item.level === "warning"));
  assert.equal(JSON.parse(await readFile(marker, "utf8")).args, "confirm", "Stopping must cancel the confirmation, not approve its side effect");

  await client.prompt(assistant.id, "/local-echo fail", "auto", "local-failed");
  await waitFor(() => events.some(event => event.type === "instance.error" && event.data.operationId === "local-failed"), "The command failure did not reach the client");
  assert.ok(notifications("local-failed").some(item => item.level === "error"));
  // Same credential boundary as tool factories: exception contents stay in local diagnostics.
  assert.ok(!JSON.stringify(events).includes("PRIVATE_COMMAND_ERROR"));
  assert.equal(team.providers.coordinator.requests.length, 0, "User commands do not request model inference");
  follower.close();
  await follower.done;

  // A tools-only private extension stays available; ordinary Pi Works have their own command list.
  const ordinary = await trustOnce(trust => client.create(team.cwd, "ordinary", "ordinary-create", trust));
  assert.ok(!(await client.commands(ordinary.id)).commands.some(command => command.name === "local-echo"));
  await client.stop(ordinary.id);

  // #671 owner decision: platform local controls and registered commands keep their names.
  // Only the colliding command is refused; adding it must not unload existing tools or other commands.
  const conflict = join(team.root, "conflicting.mjs");
  const keptCommand = join(team.root, "kept-command.txt");
  await writeFile(keptCommand, "pending");
  await writeFile(conflict, `import { writeFile } from "node:fs/promises";
    export default async function({ config }) {
      let disposed = false;
      return {
        tools: config.keep ? [{ name: "kept_local_tool", description: "Existing tool remains available",
          parameters: { type: "object", properties: {} },
          async execute() { if (disposed) throw new Error("Extension was disposed"); return { content: [{ type: "text", text: "still available" }] }; }
        }] : [],
        commands: [
          ...(config.names ?? [config.name]).map(name => ({ name, description: "Must not replace the original", execute() { return "wrong replacement"; } })),
          ...(config.keep ? [{ name: "safe-echo", description: "Valid command beside conflicting names",
            async execute() { if (disposed) throw new Error("Extension was disposed"); await writeFile(${JSON.stringify(keptCommand)}, "still callable"); return "kept"; }
          }] : []),
        ],
        dispose() { disposed = true; },
      };
    }`);
  await writeFile(configFile, JSON.stringify([...settings,
    { id: "duplicate", module: conflict, enabled: true, config: { name: "local-echo" } },
    { id: "builtin-conflict", module: conflict, enabled: true, config: { name: "assistant-status" } },
    { id: "platform-conflict", module: conflict, enabled: true, config: { names: ["reload", "model"], keep: true } },
  ]));
  await client.reloadSession(assistant.id);
  assert.deepEqual((await client.commands(assistant.id)).commands.map(command => command.name), ["assistant-status", "dock-tools", "local-echo", "safe-echo"]);
  await waitFor(async () => Object.keys((await client.status(assistant.id)).extensionStatus).includes("扩展/builtin-conflict"), "Missing conflict diagnosis");
  const status = (await client.status(assistant.id)).extensionStatus;
  assert.ok(status["扩展/duplicate"]?.includes("/local-echo"));
  assert.ok(status["扩展/builtin-conflict"]?.includes("/assistant-status"));
  assert.ok(status["扩展/platform-conflict"]?.includes("/reload") && status["扩展/platform-conflict"]?.includes("/model"), "Each refused platform name is identified for renaming");
  assert.ok((await client.tools(assistant.id)).tools.some(tool => tool.name === "kept_local_tool" && tool.source?.package === "platform-conflict"), "The module's original tool remains registered");
  await client.prompt(assistant.id, "/safe-echo", "auto", "kept-command");
  await waitFor(async () => await readFile(keptCommand, "utf8") === "still callable", "A name conflict disposed the module or removed its other command");
  assert.equal((await client.status(assistant.id)).extensionStatus["Dock tools"], "on");
  await client.prompt(assistant.id, "/dock-tools off", "auto", "builtin-still-works");
  await waitFor(async () => (await client.status(assistant.id)).extensionStatus["Dock tools"] === undefined, "The built-in command was replaced");

  await writeFile(module, source("renamed-echo"));
  await writeFile(configFile, JSON.stringify(settings));
  await client.reloadSession(assistant.id);
  assert.deepEqual((await client.commands(assistant.id)).commands.map(command => command.name), ["assistant-status", "dock-tools", "renamed-echo"]);
  await client.prompt(assistant.id, "/renamed-echo after-reload", "auto", "renamed");
  await waitFor(async () => JSON.parse(await readFile(marker, "utf8")).args === "after-reload", "Reload did not load the renamed handler");
  await writeFile(configFile, JSON.stringify(settings.map(setting => ({ ...setting, enabled: false }))));
  await client.reloadSession(assistant.id);
  assert.deepEqual((await client.commands(assistant.id)).commands.map(command => command.name), ["assistant-status", "dock-tools"]);
  assert.equal(team.providers.coordinator.requests.length, 0, "Reload and command execution remain local");

  // A removed or simply unregistered slash prefix is ordinary text, not an invalid command.
  await client.prompt(assistant.id, "/renamed-echo 请把这句话当普通消息", "auto", "ordinary-slash");
  const request = await team.providers.coordinator.request(0);
  assert.ok(JSON.stringify(request.body.messages).includes("/renamed-echo 请把这句话当普通消息"));
  request.text("收到这条普通消息。");
  await waitFor(async () => (await client.status(assistant.id)).execution === "idle", "Ordinary chat did not finish");
});
