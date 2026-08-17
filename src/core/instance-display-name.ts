import { basename } from "node:path";

import type { InstanceExecution, InstanceLifecycle } from "./instance-dto.js";

export const MAX_INSTANCE_DISPLAY_NAME_CHARS = 256;
export const MAX_CWD_FALLBACK_DISPLAY_NAME_CHARS = 20;

const SAFE_EXPLICIT_CHARACTER = /[\p{L}\p{M}\p{N}_-]/u;
const SAFE_CWD_CHARACTER = /[A-Za-z0-9_-]/u;

export interface InstanceDisplayNameSource {
  name?: string;
  key?: string;
  cwd: string;
}

/**
 * Produce the canonical, presentation-only instance label exposed by Dock.
 * This projection is deliberately total: unusual source text may degrade to
 * "Work", but it must never make an instance snapshot unavailable.
 */
export function projectInstanceDisplayName(source: InstanceDisplayNameSource): string {
  const name = safeLabel(source.name, MAX_INSTANCE_DISPLAY_NAME_CHARS, SAFE_EXPLICIT_CHARACTER);
  if (name) return name;
  const key = safeLabel(source.key, MAX_INSTANCE_DISPLAY_NAME_CHARS, SAFE_EXPLICIT_CHARACTER);
  if (key) return key;
  return cwdFallback(source.cwd);
}

/** One human status phrase per instance; UI must not surface raw lifecycle/execution enum values. */
export function humanInstanceStatus(lifecycle: InstanceLifecycle, execution: InstanceExecution): string {
  if (lifecycle === "active") {
    if (execution === "running") return "running";
    if (execution === "failed") return "run failed";
    if (execution === "unavailable") return "not responding";
    return "idle";
  }
  if (lifecycle === "stopping") return "stopping";
  if (lifecycle === "stopped") return "stopped";
  if (lifecycle === "host_lost") return "agent lost";
  return "agent crashed";
}

function cwdFallback(cwd: string): string {
  try {
    return safeLabel(basename(cwd), MAX_CWD_FALLBACK_DISPLAY_NAME_CHARS, SAFE_CWD_CHARACTER) ?? "Work";
  } catch {
    return "Work";
  }
}

function safeLabel(value: string | undefined, limit: number, allowed: RegExp): string | undefined {
  if (value === undefined) return undefined;
  try {
    const characters: string[] = [];
    let codeUnits = 0;
    let separatorPending = false;
    for (const character of value.normalize("NFKC")) {
      if (!allowed.test(character)) {
        separatorPending = codeUnits > 0;
        continue;
      }
      const separator = separatorPending && codeUnits > 0 ? " " : "";
      const nextCodeUnits = separator.length + character.length;
      if (codeUnits + nextCodeUnits > limit) break;
      if (separator) characters.push(separator);
      characters.push(character);
      codeUnits += nextCodeUnits;
      separatorPending = false;
    }
    const result = characters.join("");
    return result.length > 0 ? result : undefined;
  } catch {
    return undefined;
  }
}
