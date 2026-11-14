import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { DEFAULT_MODEL_SPEED_SUPPORT, type ModelSpeedSupport } from "../core/model-speed.js";

/** Main's editable support data travels with model configuration, never through another lookup. */
export async function readModelSpeedSupport(modelsPath: string): Promise<ModelSpeedSupport> {
  try {
    const value: unknown = JSON.parse(await readFile(join(dirname(modelsPath), "model-speed-support.json"), "utf8"));
    if (!isRecord(value) || !isRecord(value.providers)) return DEFAULT_MODEL_SPEED_SUPPORT;
    for (const rules of Object.values(value.providers)) {
      if (!isRecord(rules)) return DEFAULT_MODEL_SPEED_SUPPORT;
      for (const tier of ["fast", "ultrafast"]) {
        const patterns = rules[tier];
        if (patterns !== undefined && (!Array.isArray(patterns) || patterns.some((pattern) => typeof pattern !== "string"))) return DEFAULT_MODEL_SPEED_SUPPORT;
      }
    }
    if (value.aliases !== undefined && (!isRecord(value.aliases) || Object.values(value.aliases).some((provider) => typeof provider !== "string"))) return DEFAULT_MODEL_SPEED_SUPPORT;
    return value as unknown as ModelSpeedSupport;
  } catch {
    // Missing or unfinished edits must not stop an otherwise usable model request.
    return DEFAULT_MODEL_SPEED_SUPPORT;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
