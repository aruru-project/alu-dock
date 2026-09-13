import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { getAgentDir, getDefaultSystemPromptBody, parseDefaultSystemPromptBody, type SystemPromptSelection } from "@earendil-works/pi-coding-agent";
import type { SystemSource, SystemTemplateProvider } from "../control/system-service.js";
import type { JsonObject } from "../core/json-value.js";

/** Discovery uses only Pi's resolved native directory; no sessions or extensions are loaded. */
export function createPiSystemTemplateProvider(agentDir = getAgentDir()): SystemTemplateProvider {
  return {
    nativeSources: (cwd) => [
      { kind: "project-system", path: join(cwd, ".pi", "SYSTEM.md") },
      { kind: "global-system", path: join(agentDir, "SYSTEM.md") },
    ],
    initialTemplate: () => JSON.stringify(getDefaultSystemPromptBody(), null, 2) + "\n",
    validate: (source, text) => { if (source.kind === "dock-template") parseDefaultSystemPromptBody(JSON.parse(text.replace(/^\uFEFF/, ""))); },
    workerConfig: (source) => ({ systemSelection: { kind: source.kind, path: source.path,
      ...(source.kind === "dock-template" ? { home: dirname(dirname(dirname(source.path))) } : {}),
      ...(source.kind === "project-system" ? { cwd: dirname(dirname(source.path)) } : {}),
    } }),
  };
}

/** Keep the concrete original source through session replacement and durable reopen. */
export function piSystemPromptResolver(config: JsonObject | undefined, agentDir: string): (() => Promise<SystemPromptSelection>) | undefined {
  if (config?.systemSelection === undefined) return undefined;
  const input = config.systemSelection;
  const failure = () => new Error("无法读取所选 system。请检查原文件内容和读取权限后重新打开 Work；不会改用另一份正文。");
  if (input === null || Array.isArray(input) || typeof input !== "object" || typeof input.path !== "string") throw failure();
  const path = input.path;
  // New selections always carry the Host source Home; old Work has no systemSelection.
  const templateHome = typeof input.home === "string" && resolve(input.home) === input.home ? input.home : undefined;
  const allowed = input.kind === "project-system" ? typeof input.cwd === "string" && path === join(input.cwd, ".pi", "SYSTEM.md")
    : input.kind === "global-system" ? path === join(agentDir, "SYSTEM.md")
    : input.kind === "dock-template" && templateHome !== undefined && dirname(path) === join(templateHome, ".aludock", "systems") && path.endsWith(".json");
  if (!allowed || resolve(path) !== path) throw failure();
  return async () => {
    try {
      // Match Pi's native stripBom when loading; resource previews still return original bytes.
      const text = new TextDecoder("utf-8", { fatal: true }).decode(await readFile(path));
      return input.kind === "dock-template"
        ? { kind: "default", body: parseDefaultSystemPromptBody(JSON.parse(text)), source: { path } }
        : { kind: "custom", text, source: { path } };
    } catch { throw failure(); }
  };
}
