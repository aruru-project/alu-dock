import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";

import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { Models } from "@earendil-works/pi-ai";
import { ASSISTANT_EXTENSIONS_FILE, readAssistantExtensions } from "../assistant/extensions-config.js";
import { MAX_ALLOWED_TOOL_NAME_CHARS } from "../core/worker-tool-policy.js";
import { MAX_COLLECTION, MAX_MESSAGE, parseCommandsResult } from "../control/protocol.js";
import { compareCommandDtos, type CommandDto, type DiagnosticDto, type ResourceDto, type SourceDto } from "../core/config-projection.js";
import type { JsonObject, JsonValue } from "../core/json-value.js";
import { validateUiCapabilityArgs } from "../worker/worker-protocol.js";
import { documentResource } from "../worker/resource-files.js";
import type { AgentSkillDeclaration } from "../worker/agent-skills.js";
import controlCommandNames from "../shared/local-control-command-names.json" with { type: "json" };

/** Public assistant extension API. A plain .mjs module needs no imports or Pi SDK. */
export interface AssistantToolResult {
  content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;
  details?: JsonValue;
  isError?: boolean;
}
export interface AssistantToolCallContext {
  callId: string;
  signal: AbortSignal;
  onUpdate?: (result: AssistantToolResult) => void;
}
export interface AssistantExtensionTool {
  name: string;
  description: string;
  parameters: JsonObject;
  execute(params: JsonObject, context: AssistantToolCallContext): Promise<AssistantToolResult>;
}
/** Existing SDK Models methods only: Main keeps credential ownership; no login or configuration mutation. */
export type AssistantExtensionModels = Pick<Models, "getModels" | "getModel" | "getAvailable" | "checkAuth" | "getAuth" | "refresh">;
export interface AssistantExtensionContext {
  cwd: string;
  /** Persistent, private directory for this extension id only. Disabling does not delete it. */
  dataDir: string;
  /** A copy of only this extension's saved settings. Never included in model context by the loader. */
  config: JsonObject;
  /** Main-backed model catalog and effective auth, independent of the chatting model.
   * Auth is for trusted local code only: never include it in tool results, notices or logs. */
  readonly models: AssistantExtensionModels;
  notify(message: string, level?: "info" | "warning"): void;
  confirm(title: string, message: string, signal: AbortSignal): Promise<boolean>;
}
export interface AssistantCommandContext {
  /** Aborted when the owner stops the command, reloads extensions, or closes the Worker. */
  signal: AbortSignal;
  /** While execute is running, notifications belong to this command in the existing command console. */
  notify(message: string, level?: "info" | "warning" | "error"): void;
  confirm(title: string, message: string): Promise<boolean>;
}
export interface AssistantExtensionCommand {
  /** Invocation name without the leading slash. */
  name: string;
  description: string;
  argumentHint?: string;
  /** Free-form arguments, not shell-parsed. Returned text is shown to the owner, not sent to a model. */
  execute(args: string, context: AssistantCommandContext): string | void | Promise<string | void>;
}
export interface AssistantExtension {
  tools?: AssistantExtensionTool[];
  commands?: AssistantExtensionCommand[];
  /** Skill files/directories relative to this module; built-in factories use absolute paths. */
  skills?: string[];
  dispose?(): void | Promise<void>;
}
export type AssistantExtensionFactory = (context: AssistantExtensionContext) => Promise<AssistantExtension>;
export type AssistantBuiltinExtensions = Readonly<Record<string, AssistantExtensionFactory>>;

/** Trusted in-process code, not a sandbox. No module discovery, downloads, or runtime/session hooks. */
export class AssistantToolExtensions {
  readonly sources = new Map<string, SourceDto>();
  readonly skillDeclarations: AgentSkillDeclaration[] = [];
  private loaded: Array<{ id: string; extension: AssistantExtension }> = [];
  readonly resources: ResourceDto[] = [];
  readonly diagnostics: DiagnosticDto[] = [];
  private failures = 0;
  private lifetime = new AbortController();
  private readonly commands = new Map<string, { command: AssistantExtensionCommand; dto: CommandDto }>();
  private readonly calls = new Set<AbortController>();
  private readonly models: AssistantExtensionModels;

  constructor(
    private readonly cwd: string,
    private readonly builtins: AssistantBuiltinExtensions,
    private readonly ui: Pick<AssistantExtensionContext, "confirm"> & {
      notify(message: string, level?: "info" | "warning" | "error", operationId?: string): void;
      status(key: string, text?: string): void;
    },
    models: AssistantExtensionModels,
  ) {
    // Bind the existing public methods, not the runtime object with its private state.
    this.models = {
      getModels: models.getModels.bind(models),
      getModel: models.getModel.bind(models),
      getAvailable: models.getAvailable.bind(models),
      checkAuth: models.checkAuth.bind(models),
      getAuth: models.getAuth.bind(models),
      refresh: models.refresh.bind(models),
    };
  }

  get commandCatalog(): CommandDto[] { return [...this.commands.values()].map(({ dto }) => dto); }

  /** Only called at startup or an idle Reload; the built-in tools and commands are never replaced. */
  async load(reserved: readonly AgentTool[], reservedCommands: readonly CommandDto[] = []): Promise<AgentTool[]> {
    await this.dispose();
    this.lifetime = new AbortController();
    this.resources.length = 0;
    this.diagnostics.length = 0;
    this.failures = 0;
    this.sources.clear();
    this.commands.clear();
    this.skillDeclarations.length = 0;
    let settings;
    try { settings = await readAssistantExtensions(this.cwd); }
    catch (error) {
      this.failures++;
      this.diagnostics.push({ severity: "error", message: `工具扩展配置：${(error as Error).message}` });
      this.showStatus();
      return [];
    }
    const names = new Set(reserved.map(tool => tool.name));
    const commandOwners = new Map<string, string>([
      ...Object.values(controlCommandNames).map(name => [name, "客户端内置操作"] as const),
      ...reservedCommands.map(command => [command.name, "内置命令"] as const),
    ]);
    const tools: AgentTool[] = [];
    for (const setting of settings) {
      if (!setting.enabled) continue;
      const source: SourceDto = { kind: "extension", package: setting.id, path: setting.module };
      this.resources.push(documentResource("extension", setting.id, isAbsolute(setting.module) ? setting.module : undefined, source));
      let extension: AssistantExtension | undefined;
      try {
        let factory: AssistantExtensionFactory | undefined;
        if (setting.module.startsWith("builtin:")) {
          const name = setting.module.slice("builtin:".length);
          factory = Object.hasOwn(this.builtins, name) ? this.builtins[name] : undefined;
          if (!factory) throw new Error(`没有随包提供 ${setting.module}，请检查模块名称或更新 Dock`);
        } else {
          if (!isAbsolute(setting.module) || !/\.(mjs|js)$/u.test(setting.module)) throw new Error("请使用 Main 上的绝对 .mjs/.js 文件路径");
          const url = pathToFileURL(setting.module);
          // Reload re-evaluates the entry module, without copying its source or rewriting its imports.
          url.searchParams.set("assistantReload", randomUUID());
          factory = (await import(url.href) as { default?: AssistantExtensionFactory }).default;
        }
        if (typeof factory !== "function") throw new Error("模块需要 default 导出一个扩展工厂函数");
        const dataDir = join(this.cwd, ".assistant-extensions", setting.id);
        await mkdir(dataDir, { recursive: true, mode: 0o700 });
        extension = await factory({ cwd: this.cwd, dataDir, config: structuredClone(setting.config), models: this.models, notify: this.ui.notify, confirm: this.ui.confirm });
        if (!extension || (extension.tools === undefined && extension.commands === undefined && extension.skills === undefined)
          || (extension.tools !== undefined && !Array.isArray(extension.tools))
          || (extension.commands !== undefined && !Array.isArray(extension.commands))
          || (extension.dispose !== undefined && typeof extension.dispose !== "function")) {
          throw new Error("扩展需要返回 tools、commands 或 skills 数组，以及可选的 dispose 函数");
        }
        const extensionTools = extension.tools ?? [];
        const extensionCommands = extension.commands ?? [];
        const ownNames = new Set<string>();
        if (names.size + extensionTools.length > MAX_COLLECTION) throw new RegistrationError(`工具总数超过 ${MAX_COLLECTION} 个`);
        for (const tool of extensionTools) {
          if (!tool || typeof tool.name !== "string" || !/^[a-zA-Z0-9_-]+$/u.test(tool.name) || typeof tool.description !== "string" || !tool.description.trim()
            || !tool.parameters || typeof tool.parameters !== "object" || Array.isArray(tool.parameters) || tool.parameters.type !== "object" || typeof tool.execute !== "function") {
            throw new Error("工具需要 name、description、object JSON Schema parameters 和 execute 函数");
          }
          if (tool.name.length > MAX_ALLOWED_TOOL_NAME_CHARS) throw new RegistrationError(`工具名超过 ${MAX_ALLOWED_TOOL_NAME_CHARS} 字符`);
          if (tool.description.length > MAX_MESSAGE) throw new RegistrationError(`工具描述超过 ${MAX_MESSAGE} 字符`);
          if (names.has(tool.name) || ownNames.has(tool.name)) throw new RegistrationError(`工具名 ${tool.name} 已被占用，请改名后 Reload；原工具没有被替换。`);
          ownNames.add(tool.name);
        }
        const ownCommands = new Map<string, { command: AssistantExtensionCommand; dto: CommandDto }>();
        const commandProblems: string[] = [];
        for (const command of extensionCommands) {
          if (!command || typeof command.name !== "string" || !/^[a-zA-Z0-9_-]+$/u.test(command.name)
            || typeof command.description !== "string" || !command.description.trim() || typeof command.execute !== "function") {
            throw new Error("命令需要不带斜杠的 name、description 和 execute 函数");
          }
          const owner = commandOwners.get(command.name) ?? (ownCommands.has(command.name) ? "本扩展的另一条命令" : undefined);
          if (owner !== undefined) {
            commandProblems.push(`命令 /${command.name} 已由「${owner}」提供，这条命令未注册。请改名后 Reload；本扩展的工具和其它有效命令保持可用。`);
            continue;
          }
          ownCommands.set(command.name, { command, dto: {
            name: command.name, description: command.description, source, argumentCompletions: false,
            ...(command.argumentHint === undefined ? {} : { argumentHint: command.argumentHint }),
          } });
        }
        // Use the public result parser's limits before publishing any part of this extension.
        const catalog = [...reservedCommands, ...this.commandCatalog, ...[...ownCommands.values()].map(({ dto }) => dto)].sort(compareCommandDtos);
        parseCommandsResult({ commands: catalog, total: catalog.length, truncated: false });
        for (const registered of ownCommands.values()) {
          this.commands.set(registered.command.name, registered);
          commandOwners.set(registered.command.name, `扩展 ${setting.id}`);
        }
        for (const tool of extensionTools) {
          names.add(tool.name);
          this.sources.set(tool.name, source);
          tools.push({
            name: tool.name, label: tool.name, description: tool.description,
            parameters: tool.parameters as AgentTool["parameters"],
            execute: async (callId, params, signal, onUpdate) => {
              const callSignal = signal ? AbortSignal.any([signal, this.lifetime.signal]) : this.lifetime.signal;
              try {
                const result = await tool.execute(params as JsonObject, {
                  callId, signal: callSignal,
                  ...(onUpdate === undefined ? {} : { onUpdate: (partial: AssistantToolResult) => onUpdate({ ...partial, details: partial.details }) }),
                });
                return { ...result, details: result.details };
              } catch {
                // The Agent turns exceptions into model-visible tool results. Never hand it the
                // original error (or cause), even when an extension rejects during cancellation.
                if (callSignal.aborted) throw new DOMException("工具调用已中止。", "AbortError");
                console.error(`Assistant extension ${setting.id} tool_failed ${tool.name}: Check the extension settings and implementation, then retry.`);
                throw new Error(`扩展 ${setting.id} 的工具 ${tool.name} 执行失败。请检查扩展设置和实现后重试。`);
              }
            },
          });
        }
        this.loaded.push({ id: setting.id, extension });
        for (const problem of commandProblems) this.diagnostics.push({ severity: "error", message: `工具扩展 ${setting.id}：${problem}` });
        // Manuals are independent of tool/command registration: malformed or missing skills only
        // produce resource diagnostics, and cannot roll back working tools or commands.
        this.skillDeclarations.push(
          { paths: extension.skills, source, ...(setting.module.startsWith("builtin:") ? {} : {
            baseDir: dirname(setting.module),
            ...(setting.skills === undefined ? { defaultDirectory: join(dirname(setting.module), "skills") } : {}),
          }) },
          { paths: setting.skills, baseDir: this.cwd, source: { ...source, path: join(this.cwd, ASSISTANT_EXTENSIONS_FILE) } },
        );
      } catch (error) {
        if (typeof extension?.dispose === "function") {
          try { await extension.dispose(); } catch { /* The load error remains the useful diagnosis. */ }
        }
        // Unknown exceptions may contain credentials anywhere, including nested/custom properties.
        // Log only loader-owned facts; neither UI nor local diagnostics receive the exception.
        console.error(`Assistant extension ${setting.id} load_failed: Check extensions.json and the extension module, then Reload.`);
        this.failures++;
        const reason = error instanceof RegistrationError ? error.message : `加载失败。请检查 Main 上的 ${join(this.cwd, ASSISTANT_EXTENSIONS_FILE)} 和扩展文件后 Reload。`;
        this.diagnostics.push({ severity: "error", message: `工具扩展 ${setting.id}：${reason}` });
      }
    }
    this.showStatus();
    return tools;
  }

  /** Only registered names take over input. An unknown /prefix remains an ordinary message. */
  matchCommand(message: string): { name: string; args: string } | undefined {
    const match = /^\s*\/([^\s/]+)(?:\s+([\s\S]*))?$/u.exec(message);
    return match && this.commands.has(match[1]!) ? { name: match[1]!, args: match[2] ?? "" } : undefined;
  }

  async executeCommand(name: string, args: string, operationId: string): Promise<void> {
    const registered = this.commands.get(name);
    if (!registered) throw new Error(`命令 /${name} 已不在当前扩展中，请重新打开命令列表。`);
    const lifetime = this.lifetime.signal;
    const controller = new AbortController();
    this.calls.add(controller);
    const signal = AbortSignal.any([controller.signal, lifetime]);
    let active = true;
    const notify: AssistantCommandContext["notify"] = (message, level = "info") => {
      if (lifetime.aborted) return;
      // Report malformed output as a command failure instead of silently losing its notification.
      validateUiCapabilityArgs("ui.notify", { message, level });
      this.ui.notify(message, level, active ? operationId : undefined);
    };
    const progress = setTimeout(() => notify(`正在执行 /${name}，可以用中止取消。`), 1_000).unref();
    try {
      const result = await registered.command.execute(args, {
        signal, notify,
        confirm: (title, message) => this.ui.confirm(title, message, signal),
      });
      signal.throwIfAborted();
      if (result !== undefined && typeof result !== "string") throw new Error("Command execute must return text or nothing");
      notify(result || `命令 /${name} 已完成。`);
    } catch {
      if (signal.aborted) {
        notify(`命令 /${name} 已中止。`, "warning");
        return;
      }
      console.error(`Assistant extension ${registered.dto.source.package} command_failed /${name}: Check the extension settings and implementation, then retry.`);
      const message = `命令 /${name} 执行失败。请检查扩展设置和实现后重试。`;
      notify(message, "error");
      throw new Error(message);
    } finally {
      active = false;
      clearTimeout(progress);
      this.calls.delete(controller);
    }
  }

  abortCommands(): void { for (const controller of this.calls) controller.abort(); }

  showStatus(): void {
    const loaded = this.loaded.length;
    this.ui.status("工具扩展", this.failures ? `${loaded} 个已加载，${this.failures} 个失败` : loaded ? `${loaded} 个已加载` : undefined);
  }

  async dispose(): Promise<string[]> {
    this.lifetime.abort();
    const errors: string[] = [];
    for (const { id, extension } of this.loaded.splice(0)) {
      try { await extension.dispose?.(); }
      catch {
        console.error(`Assistant extension ${id} dispose_failed: Check the extension cleanup implementation, then restart the assistant.`);
        const message = `扩展 ${id} 没有正常关闭。请检查扩展的关闭处理后重新启动助手。`;
        errors.push(message);
        this.ui.notify(message, "warning");
      }
    }
    return errors;
  }
}

/** Only loader-owned, non-secret diagnoses may be displayed verbatim. */
class RegistrationError extends Error {}
