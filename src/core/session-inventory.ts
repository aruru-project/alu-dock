import type { SessionDto } from "./instance-dto.js";

/**
 * Host-owned, read-only inventory of persisted Pi sessions. Implementations may
 * inspect session metadata, but must not construct a runtime or load project
 * resources.
 */
export interface SessionInventory {
  list(cwd: string, scope: "cwd" | "all"): Promise<SessionDto[]>;
}
