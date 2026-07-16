import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

const MAX_INSPECTED_RESULTS = 256;

/**
 * Pi 0.80.6 treats an extension tool's returned `isError` field as ordinary
 * payload metadata. pi-subagents also records each child exit code in details,
 * so normalize that authoritative child outcome through the public
 * `tool_result` hook before the model, session history, and Dock projection see
 * the result.
 */
export function subagentDetailsContainFailure(details: unknown): boolean {
  try {
    if (!isRecord(details)) return false;
    if (details.timedOut === true) return true;
    const results = details.results;
    if (!Array.isArray(results)) return false;
    // pi-subagents currently admits at most 50 tasks. Treat a larger result set
    // as unprovable success rather than traversing attacker-controlled telemetry.
    const resultCount = results.length;
    if (resultCount > MAX_INSPECTED_RESULTS) return true;
    for (let index = 0; index < resultCount; index += 1) {
      const result = results[index];
      if (!isRecord(result)) continue;
      if (typeof result.exitCode === "number" && Number.isFinite(result.exitCode) && result.exitCode !== 0) return true;
      if (result.timedOut === true) return true;
    }
    return false;
  } catch {
    // A malformed Proxy/getter must not escape into Pi's extension runner or be
    // mistaken for a successful child result.
    return true;
  }
}

export const piToolResultNormalizerExtension: ExtensionFactory = (pi) => {
  pi.on("tool_result", (event) => {
    if (event.toolName !== "subagent" || event.isError || !subagentDetailsContainFailure(event.details)) return undefined;
    return { isError: true };
  });
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
