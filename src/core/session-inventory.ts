import type { SessionDto } from "./instance-dto.js";

export interface SessionInventoryDiagnostic {
  message: string;
  path?: string;
}

export interface SessionInventoryScan {
  sessions: SessionDto[];
  /** True when one or more authoritative JSONL locations could not be inspected. */
  incomplete: boolean;
  diagnostics: SessionInventoryDiagnostic[];
  diagnosticsTruncated?: boolean;
}

/**
 * Host-owned, read-only inventory of persisted Pi sessions. Implementations may
 * inspect session metadata, but must not construct a runtime or load project
 * resources. Scan failures stay distinguishable from a genuinely empty result.
 */
export interface SessionInventory {
  list(cwd: string, scope: "cwd" | "all"): Promise<SessionInventoryScan>;
}
