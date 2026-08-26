import { cloneBoundedJsonObject, type JsonObject } from "./json-value.js";

/** Caps this field's contribution to the private Worker process bootstrap. */
export const MAX_WORKER_CONFIG_BYTES = 16_000;

/** The one generic validation boundary for adapter-owned Worker creation input. */
export function cloneWorkerConfig(input: unknown, label = "Worker configuration"): JsonObject {
  const result = cloneBoundedJsonObject(input, label);
  if (Buffer.byteLength(JSON.stringify(result), "utf8") > MAX_WORKER_CONFIG_BYTES) {
    throw new Error(`${label} is too large`);
  }
  return result;
}
