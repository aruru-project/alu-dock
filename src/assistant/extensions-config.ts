import { randomUUID } from "node:crypto";
import { link, lstat, readFile, rm } from "node:fs/promises";
import { isAbsolute, join, win32 } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { cloneBoundedJsonObject, type JsonObject } from "../core/json-value.js";
import { syncPrivateDirectory, writePrivateStateFile } from "../platform/private-state.js";

/** Main-local configuration, never part of the public assistant settings or model context. */
export interface AssistantExtensionSettings {
  id: string;
  module: string;
  enabled: boolean;
  config: JsonObject;
  /** Optional manual paths, relative to extensions.json. Validated separately so a bad manual
   * never prevents an otherwise working extension from loading. */
  skills?: unknown;
}

export const ASSISTANT_EXTENSIONS_FILE = "extensions.json";

/** A missing file keeps the shipped web tools; an explicit [] loads no extensions. */
export async function readAssistantExtensions(workspace: string): Promise<AssistantExtensionSettings[]> {
  const path = join(workspace, ASSISTANT_EXTENSIONS_FILE);
  let text: string;
  try { text = await readFile(path, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      // A dangling link is a broken configuration, not a request for the shipped defaults.
      try { await lstat(path); }
      catch (missing) {
        if ((missing as NodeJS.ErrnoException).code === "ENOENT") return [{ id: "web", module: "builtin:web", enabled: true, config: {} }];
      }
    }
    throw new Error(`无法读取助手扩展配置，扩展没有加载。请检查 Main 上的 ${path} 及其读取权限后 Reload。`);
  }
  try { return parseAssistantExtensions(JSON.parse(text)); }
  catch {
    // JSON.parse and opaque config validation can quote private values or keys. Never forward them.
    throw new Error(`助手扩展配置格式有误，扩展没有加载。请检查 Main 上的 ${path}：应为包含 id、module、enabled、config 的数组，修正后 Reload。`);
  }
}

/** The same shape previously saved in SQLite, now owned only by Main's local config file. */
function parseAssistantExtensions(input: unknown): AssistantExtensionSettings[] {
  if (!Array.isArray(input)) throw new Error("Expected an extension array");
  const ids = new Set<string>();
  return input.map((raw: unknown) => {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Expected an extension object");
    const item = raw as Record<string, unknown>;
    if (Object.keys(item).some(key => !["id", "module", "enabled", "config", "skills"].includes(key))) throw new Error("Unknown extension field");
    const { id, module, enabled } = item;
    if (typeof id !== "string" || id.length > 64 || !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/u.test(id) || ids.has(id)) throw new Error("Invalid or duplicate extension id");
    ids.add(id);
    if (typeof module !== "string" || module.length > 16_384
      || (!/^builtin:[a-zA-Z0-9_-]+$/u.test(module) && !((isAbsolute(module) || win32.isAbsolute(module)) && /\.(mjs|js)$/u.test(module)))) throw new Error("Invalid extension module");
    if (typeof enabled !== "boolean") throw new Error("Expected enabled boolean");
    return { id, module, enabled, config: cloneBoundedJsonObject(item.config), ...(item.skills === undefined ? {} : { skills: item.skills }) };
  });
}

/**
 * RC6 stored the only copy in memory.sqlite. Publish those exact bytes once, without overwriting a
 * hand-edited file. A conflicting file wins; the old bytes remain in a private, inert backup. After
 * durable publication the database key is removed, so it can never become a fallback source.
 */
export async function migrateAssistantExtensions(workspace: string, database: DatabaseSync): Promise<string | undefined> {
  const row = database.prepare("SELECT value FROM meta WHERE key = 'tool_extensions'").get() as { value: string } | undefined;
  if (row === undefined) return undefined;
  const backupName = `extensions.sqlite-backup-${randomUUID()}.json`;
  const backupPath = join(workspace, backupName);
  let published = false;
  try {
    await writePrivateStateFile(workspace, backupName, row.value);
    try {
      // Unlike rename, link cannot replace a file saved by the owner while migration was running.
      await link(backupPath, join(workspace, ASSISTANT_EXTENSIONS_FILE));
      published = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    await syncPrivateDirectory(workspace);
    database.prepare("DELETE FROM meta WHERE key = 'tool_extensions'").run();
  } catch {
    throw new Error(`助手扩展配置迁移没有完成，旧设置仍保留在记忆数据库中。请检查 Main 上的 ${workspace} 的写入权限和可用空间后重试。`);
  }
  if (!published) return backupPath;
  // Publication and retirement of the database key already succeeded; a leftover backup is inert.
  await rm(backupPath, { force: true }).catch(() => {});
  return undefined;
}
