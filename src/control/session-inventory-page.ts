import { createHash } from "node:crypto";

import type { SessionDto } from "../core/instance-dto.js";
import type { SessionInventoryScan } from "../core/session-inventory.js";
import { MAX_SESSION_INVENTORY_CURSOR_CHARS, ProtocolValidationError, type SessionInventoryResult } from "./protocol.js";

const MAX_SESSION_INVENTORY_RESULT_BYTES = 512 * 1_024;
const MAX_SESSION_INVENTORY_DIAGNOSTIC_BYTES = 64 * 1_024;
const MAX_SESSION_INVENTORY_ITEMS = 2_000;

interface PagePosition {
  /** Latest conversation time in epoch milliseconds; null sorts after every dated session. */
  time: number | null;
  /** Stable tie-breaker that does not expose the private session file path in the cursor. */
  key: string;
}

/**
 * One page of the persisted-session listing, newest conversation first.
 * A request without a cursor is the first page, identical to the unpaged
 * listing older clients read; `nextCursor` continues after the last session.
 */
export function sessionInventoryPage(
  source: SessionInventoryScan,
  query: SessionInventoryResult["query"],
  cursor?: string,
): SessionInventoryResult {
  const diagnostics: SessionInventoryResult["diagnostics"] = [];
  let diagnosticBytes = 0;
  for (const diagnostic of source.diagnostics) {
    const itemBytes = Buffer.byteLength(JSON.stringify(diagnostic), "utf8") + 1;
    if (diagnosticBytes + itemBytes > MAX_SESSION_INVENTORY_DIAGNOSTIC_BYTES) break;
    diagnostics.push(diagnostic);
    diagnosticBytes += itemBytes;
  }

  const ordered = source.sessions
    .map((session) => ({ session, position: pagePosition(session) }))
    .sort((left, right) => comparePositions(left.position, right.position));
  const after = cursor === undefined ? undefined : decodeCursor(cursor);
  const start = after === undefined ? 0 : ordered.findIndex((item) => comparePositions(item.position, after) > 0);
  const remaining = start < 0 ? [] : ordered.slice(start);

  const page: typeof ordered = [];
  let bytes = 512 + Buffer.byteLength(query.cwd, "utf8") + diagnosticBytes;
  for (const item of remaining.slice(0, MAX_SESSION_INVENTORY_ITEMS)) {
    const itemBytes = Buffer.byteLength(JSON.stringify(item.session), "utf8") + 1;
    if (bytes + itemBytes > MAX_SESSION_INVENTORY_RESULT_BYTES) break;
    page.push(item);
    bytes += itemBytes;
  }
  if (page.length === 0 && remaining.length > 0) throw new Error("A saved session exceeds the session inventory page bound");

  const last = page.at(-1);
  const sessions = page.map((item) => item.session);
  return {
    sessions,
    query: { cwd: query.cwd, scope: query.scope },
    total: ordered.length,
    truncated: sessions.length < ordered.length,
    incomplete: source.incomplete,
    diagnostics,
    diagnosticsTruncated: source.diagnosticsTruncated === true || diagnostics.length < source.diagnostics.length,
    ...(last !== undefined && page.length < remaining.length ? { nextCursor: encodeCursor(last.position) } : {}),
  };
}

function pagePosition(session: SessionDto): PagePosition {
  const time = Date.parse(session.lastActivityAt ?? session.updatedAt ?? "");
  return {
    time: Number.isFinite(time) ? time : null,
    key: createHash("sha256").update(session.sessionFile).digest("hex").slice(0, 32),
  };
}

function comparePositions(left: PagePosition, right: PagePosition): number {
  if (left.time !== right.time) {
    if (left.time === null) return 1;
    if (right.time === null) return -1;
    return right.time - left.time;
  }
  return left.key < right.key ? -1 : left.key > right.key ? 1 : 0;
}

function encodeCursor(position: PagePosition): string {
  const cursor = Buffer.from(JSON.stringify({ t: position.time, k: position.key }), "utf8").toString("base64url");
  if (cursor.length > MAX_SESSION_INVENTORY_CURSOR_CHARS) throw new Error("Session inventory cursor exceeded its bound");
  return cursor;
}

function decodeCursor(cursor: string): PagePosition {
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { t?: unknown; k?: unknown };
    const time = value.t;
    if ((time === null || (typeof time === "number" && Number.isFinite(time))) && typeof value.k === "string" && /^[0-9a-f]{32}$/u.test(value.k)) {
      return { time, key: value.k };
    }
  } catch {
    // Reported below with the same user-facing reason as a structurally wrong cursor.
  }
  throw new ProtocolValidationError("invalid_request", "The saved-session list position is no longer valid; reopen the list");
}
