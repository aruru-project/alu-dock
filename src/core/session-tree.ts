import type { AgentNavigateResult } from "./agent-worker.js";

/** Validate the private navigation outcome before Host lifecycle facts are added. */
export function projectAgentNavigateResult(result: AgentNavigateResult): AgentNavigateResult {
  if (result === null || typeof result !== "object" || typeof result.cancelled !== "boolean" || typeof result.summaryCreated !== "boolean") {
    throw new Error("Runtime returned an invalid tree navigation result");
  }
  if (result.aborted !== undefined && typeof result.aborted !== "boolean") throw new Error("Runtime returned an invalid navigation abort state");
  if (result.aborted === true && !result.cancelled) throw new Error("Aborted tree navigation must be cancelled");
  if (result.editorText !== undefined && (typeof result.editorText !== "string" || result.editorText.length > 256_000)) {
    throw new Error("Runtime returned invalid or oversized navigation editor text");
  }
  if (result.leafId !== undefined && (typeof result.leafId !== "string" || result.leafId.length < 1 || result.leafId.length > 128)) {
    throw new Error("Runtime returned an invalid navigation leaf");
  }
  const editorText = result.editorText === undefined ? undefined : safeTreeText(result.editorText, 256_000);
  if (result.cancelled && editorText !== undefined) throw new Error("Cancelled tree navigation cannot return editor text");
  return {
    cancelled: result.cancelled,
    ...(result.aborted === undefined ? {} : { aborted: result.aborted }),
    ...(editorText === undefined ? {} : { editorText }),
    ...(result.leafId === undefined ? {} : { leafId: result.leafId }),
    summaryCreated: result.summaryCreated,
  };
}

function safeTreeText(value: string, limit: number): string | undefined {
  const sanitized = value.replace(/\r\n?/gu, "\n").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu, " ");
  if (sanitized.length === 0) return undefined;
  return sanitized.length <= limit ? sanitized : `${sanitized.slice(0, limit - 1)}…`;
}
