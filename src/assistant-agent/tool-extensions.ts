import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";

import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { Models } from "@earendil-works/pi-ai";
import { ASSISTANT_EXTENSIONS_FILE, readAssistantExtensions } from "../assistant/extensions-config.js";
import { parseCommandsResult } from "../control/protocol.js";
import { compareCommandDtos, type CommandDto, type SourceDto } from "../core/config-projection.js";
import type { JsonObject, JsonValue } from "../core/json-value.js";
import { validateUiCapabilityArgs } from "../worker/worker-protocol.js";
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
  private statuses = new Map<string, string>();
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

  /** Requested details include successful loads without putting them back in the chat status bar. */
  details(): string {
    const loaded = this.loaded.map(({ id, extension }) => `${id}：已加载，${extension.tools?.length ?? 0} 个工具、${this.commandCatalog.filter(command => command.source.package === id).length} 个命令。`);
    const failures = [...this.statuses].map(([id, text]) => `${id}：${text}`);
    return [...loaded, ...failures].join("\n") || "没有已加载的工具扩展。";
  }

  /** Only called at startup or an idle Reload; the built-in tools and commands are never replaced. */
  async load(reserved: readonly AgentTool[], reservedCommands: readonly CommandDto[] = []): Promise<AgentTool[]> {
    await this.dispose();
    this.lifetime = new AbortController();
    this.statuses.clear();
    this.showStatus();
    this.sources.clear();
    this.commands.clear();
    this.skillDeclarations.length = 0;
    let settings;
    try { settings = await readAssistantExtensions(this.cwd); }
    catch (error) {
      this.status("配置", (error as Error).message);
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
        const source: SourceDto = { kind: "extension", package: setting.id, path: setting.module };
        const ownNames = new Set<string>();
        for (const tool of extensionTools) {
          if (!tool || typeof tool.name !== "string" || !/^[a-zA-Z0-9_-]+$/u.test(tool.name) || typeof tool.description !== "string" || !tool.description.trim()
            || !tool.parameters || typeof tool.parameters !== "object" || Array.isArray(tool.parameters) || tool.parameters.type !== "object" || typeof tool.execute !== "function") {
            throw new Error("工具需要 name、description、object JSON Schema parameters 和 execute 函数");
          }
          if (names.has(tool.name) || ownNames.has(tool.name)) throw new RegistrationConflict(`工具名 ${tool.name} 已被占用，请改名后 Reload；原工具没有被替换。`);
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
              const result = await tool.execute(params as JsonObject, {
                callId, signal: signal ? AbortSignal.any([signal, this.lifetime.signal]) : this.lifetime.signal,
                ...(onUpdate === undefined ? {} : { onUpdate: (partial: AssistantToolResult) => onUpdate({ ...partial, details: partial.details }) }),
              });
              return { ...result, details: result.details };
            },
          });
        }
        this.loaded.push({ id: setting.id, extension });
        if (commandProblems.length) this.status(setting.id, commandProblems.join("\n"));
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
        // Factory errors may quote private config. Details stay in local Worker diagnostics.
        console.error(`Assistant extension ${setting.id} failed to load:`, error);
        this.status(setting.id, error instanceof RegistrationConflict ? error.message
          : `加载失败。请检查 Main 上的 ${join(this.cwd, ASSISTANT_EXTENSIONS_FILE)} 和扩展文件后 Reload；详情见本机日志。`);
      }
    }
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
    } catch (error) {
      if (signal.aborted) {
        notify(`命令 /${name} 已中止。`, "warning");
        return;
      }
      // Extension exceptions can contain credentials; keep the original in local diagnostics only.
      console.error(`Assistant command /${name} failed:`, error);
      const message = `命令 /${name} 执行失败。请检查扩展设置和本机日志后重试。`;
      notify(message, "error");
      throw new Error(message);
    } finally {
      active = false;
      clearTimeout(progress);
      this.calls.delete(controller);
    }
  }

  abortCommands(): void { for (const controller of this.calls) controller.abort(); }

  /** Only actionable failures are re-published after activate/reload; normal tools stay quiet. */
  showStatus(): void {
    this.ui.status("工具扩展", this.statuses.size ? "有扩展未完全加载，请在命令中心查看助手运行详情。" : undefined);
  }
  private status(id: string, text: string): void { this.statuses.set(id, text); this.showStatus(); }

  async dispose(): Promise<string[]> {
    this.lifetime.abort();
    const errors: string[] = [];
    for (const { id, extension } of this.loaded.splice(0)) {
      try { await extension.dispose?.(); }
      catch (error) {
        console.error(`Assistant extension ${id} failed to dispose:`, error);
        const message = `扩展 ${id} 没有正常关闭。可重新启动助手，详情见本机日志。`;
        errors.push(message);
        this.ui.notify(message, "warning");
      }
    }
    return errors;
  }
}

/** Only loader-owned, non-secret diagnoses may be displayed verbatim. */
class RegistrationConflict extends Error {}
