import { realpath } from "node:fs/promises";
import { resolve } from "node:path";

import { SessionManager, type SessionInfo } from "@earendil-works/pi-coding-agent";

import type { SessionDto } from "../core/instance-dto.js";
import type { SessionInventory } from "../core/session-inventory.js";

/** Read persisted Pi session metadata without constructing an AgentSession/runtime. */
export function createPiSessionInventory(): SessionInventory {
  return {
    async list(cwd, scope) {
      const canonicalCwd = await realpath(resolve(cwd));
      const sessions = scope === "cwd"
        ? await SessionManager.list(canonicalCwd)
        : await SessionManager.listAll();
      return sessions.map(projectSession);
    },
  };
}

function projectSession(session: SessionInfo): SessionDto {
  const name = boundedOptionalText(session.name, 256);
  return {
    sessionId: boundedText(session.id, 128),
    sessionFile: resolve(session.path).slice(0, 16_384),
    ...(name === undefined ? {} : { name }),
    cwd: boundedText(session.cwd, 16_384),
    ...(Number.isFinite(session.modified.getTime()) ? { updatedAt: session.modified.toISOString() } : {}),
  };
}

function boundedText(value: string, limit: number): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ").slice(0, limit);
}

function boundedOptionalText(value: string | undefined, limit: number): string | undefined {
  if (value === undefined) return undefined;
  const projected = boundedText(value, limit).trim();
  return projected.length === 0 ? undefined : projected;
}
