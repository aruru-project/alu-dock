import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";

import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { AssistantExtensionSettings } from "../core/assistant.js";
import type { SourceDto } from "../core/config-projection.js";
import type { JsonObject, JsonValue } from "../core/json-value.js";

/** Public assistant tool API. A plain .mjs module needs no imports or Pi SDK. */
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
export interface AssistantExtensionContext {
  cwd: string;
  /** Persistent, private directory for this extension id only. Disabling does not delete it. */
  dataDir: string;
  /** A copy of only this extension's saved settings. Never included in model context by the loader. */
  config: JsonObject;
  notify(message: string, level?: "info" | "warning"): void;
  confirm(title: string, message: string, signal: AbortSignal): Promise<boolean>;
}
export interface AssistantExtension {
  tools: AssistantExtensionTool[];
  dispose?(): void | Promise<void>;
}
export type AssistantExtensionFactory = (context: AssistantExtensionContext) => Promise<AssistantExtension>;
export type AssistantBuiltinExtensions = Readonly<Record<string, AssistantExtensionFactory>>;

/** Trusted in-process code, not a sandbox. No discovery, downloads, or runtime/session hooks. */
export class AssistantToolExtensions {
  readonly sources = new Map<string, SourceDto>();
  private loaded: Array<{ id: string; extension: AssistantExtension }> = [];
  private statuses = new Map<string, string>();
  private lifetime = new AbortController();

  constructor(
    private readonly cwd: string,
    private readonly builtins: AssistantBuiltinExtensions,
    private readonly ui: Pick<AssistantExtensionContext, "notify" | "confirm"> & { status(key: string, text?: string): void },
  ) {}

  /** Only called at startup or an idle Reload; the built-in tools are never replaced. */
  async load(settings: readonly AssistantExtensionSettings[], reserved: readonly AgentTool[]): Promise<AgentTool[]> {
    await this.dispose();
    this.lifetime = new AbortController();
    for (const id of this.statuses.keys()) this.ui.status(`扩展/${id}`);
    this.statuses.clear();
    this.sources.clear();
    const names = new Set(reserved.map(tool => tool.name));
    const tools: AgentTool[] = [];
    for (const setting of settings) {
      if (!setting.enabled) { this.status(setting.id, "已停用"); continue; }
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
        extension = await factory({ cwd: this.cwd, dataDir, config: structuredClone(setting.config), notify: this.ui.notify, confirm: this.ui.confirm });
        if (!extension || !Array.isArray(extension.tools) || (extension.dispose !== undefined && typeof extension.dispose !== "function")) throw new Error("扩展需要返回 tools 数组和可选的 dispose 函数");
        const ownNames = new Set<string>();
        for (const tool of extension.tools) {
          if (!tool || typeof tool.name !== "string" || !/^[a-zA-Z0-9_-]+$/u.test(tool.name) || typeof tool.description !== "string" || !tool.description.trim()
            || !tool.parameters || typeof tool.parameters !== "object" || Array.isArray(tool.parameters) || tool.parameters.type !== "object" || typeof tool.execute !== "function") {
            throw new Error("工具需要 name、description、object JSON Schema parameters 和 execute 函数");
          }
          if (names.has(tool.name) || ownNames.has(tool.name)) throw new Error(`工具名 ${tool.name} 已被占用，请改名；原工具没有被替换`);
          ownNames.add(tool.name);
        }
        for (const tool of extension.tools) {
          names.add(tool.name);
          this.sources.set(tool.name, { kind: "extension", package: setting.id, path: setting.module });
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
        this.status(setting.id, `已加载，${extension.tools.length} 个工具`);
      } catch (error) {
        if (typeof extension?.dispose === "function") {
          try { await extension.dispose(); } catch { /* The load error remains the useful diagnosis. */ }
        }
        this.status(setting.id, `加载失败：${error instanceof Error ? error.message : String(error)}。请修正后 Reload。`);
      }
    }
    return tools;
  }

  /** Re-publish after activate/reload, using the existing Work extension status surface. */
  showStatus(): void { for (const [id, text] of this.statuses) this.ui.status(`扩展/${id}`, text); }
  private status(id: string, text: string): void { this.statuses.set(id, text); this.ui.status(`扩展/${id}`, text); }

  async dispose(): Promise<string[]> {
    this.lifetime.abort();
    const errors: string[] = [];
    for (const { id, extension } of this.loaded.splice(0)) {
      try { await extension.dispose?.(); }
      catch (error) {
        const message = `扩展 ${id} 清理失败：${error instanceof Error ? error.message : String(error)}`;
        errors.push(message);
        this.ui.notify(`${message}。可重新启动助手。`, "warning");
      }
    }
    return errors;
  }
}
