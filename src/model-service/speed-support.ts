import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { DEFAULT_MODEL_SPEED_SUPPORT, type ModelSpeedSupport } from "../core/model-speed.js";

/** Main's Dock-owned support data; Pi and other Agents receive it, never choose its storage location. */
export async function readModelSpeedSupport(stateDirectory: string, lastKnown = DEFAULT_MODEL_SPEED_SUPPORT): Promise<ModelSpeedSupport> {
  try {
    const value: unknown = JSON.parse(await readFile(join(stateDirectory, "model-speed-support.json"), "utf8"));
    if (!isRecord(value) || (value.providers !== undefined && !isRecord(value.providers))) return lastKnown;
    const providers = { ...DEFAULT_MODEL_SPEED_SUPPORT.providers };
    for (const [provider, rules] of Object.entries(value.providers ?? {})) {
      if (!isRecord(rules)) return lastKnown;
      for (const tier of ["fast", "ultrafast"]) {
        const patterns = rules[tier];
        if (patterns !== undefined && (!Array.isArray(patterns) || patterns.some((pattern) => typeof pattern !== "string"))) return lastKnown;
      }
      providers[provider] = { ...providers[provider], ...rules };
    }
    if (value.aliases !== undefined && (!isRecord(value.aliases) || Object.values(value.aliases).some((provider) => typeof provider !== "string"))) return lastKnown;
    return { providers, ...(value.aliases === undefined ? {} : { aliases: value.aliases as Record<string, string> }) };
  } catch {
    // Missing or unfinished edits must not erase support an open Work already knows.
    return lastKnown;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
