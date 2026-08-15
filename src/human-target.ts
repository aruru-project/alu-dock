import type { InstanceSnapshot } from "./core/managed-instance.js";

export type HumanTargetResolution =
  | { kind: "resolved"; instance: InstanceSnapshot }
  | { kind: "not_found"; target: string; message: string }
  | { kind: "ambiguous"; target: string; candidates: InstanceSnapshot[]; message: string };

/** Resolve only exact IDs, unique ID prefixes, and exact names. Never guess. */
export function resolveHumanTarget(
  instances: readonly InstanceSnapshot[],
  rawTarget: string,
): HumanTargetResolution {
  const target = rawTarget;
  if (target.trim().length === 0) {
    return {
      kind: "not_found",
      target,
      message: "TARGET must not be empty. Use a full ID, displayed unique prefix, or unique exact name.",
    };
  }
  const exactId = instances.find((instance) => instance.id === target);
  if (exactId) return { kind: "resolved", instance: exactId };

  const candidates = new Map<string, InstanceSnapshot>();
  for (const instance of instances) {
    if (instance.id.startsWith(target) || instance.name === target) candidates.set(instance.id, instance);
  }
  const matches = [...candidates.values()].sort((left, right) => left.id.localeCompare(right.id));
  if (matches.length === 1) return { kind: "resolved", instance: matches[0] as InstanceSnapshot };
  if (matches.length === 0) {
    return {
      kind: "not_found",
      target,
      message: `No Dock instance matches TARGET ${quote(target)}. Run \`aludock list --all\` or open the Hub with \`aludock\`.`,
    };
  }
  const choices = matches.slice(0, 6).map((instance) => `${displayName(instance)} [${instance.id}]`).join(", ");
  return {
    kind: "ambiguous",
    target,
    candidates: matches,
    message: `TARGET ${quote(target)} is ambiguous: ${choices}${matches.length > 6 ? `, and ${matches.length - 6} more` : ""}. Use a longer ID prefix or the full ID.`,
  };
}

export function requireHumanTarget(
  instances: readonly InstanceSnapshot[],
  target: string,
): InstanceSnapshot {
  const resolution = resolveHumanTarget(instances, target);
  if (resolution.kind === "resolved") return resolution.instance;
  throw new Error(resolution.message);
}

/** Prefix shown to people must round-trip through resolveHumanTarget(). */
export function uniqueInstanceIdPrefix(
  instance: InstanceSnapshot,
  universe: readonly InstanceSnapshot[],
  minimum = 8,
): string {
  const start = Math.min(instance.id.length, Math.max(1, Math.floor(minimum)));
  for (let length = start; length < instance.id.length; length += 1) {
    const prefix = instance.id.slice(0, length);
    const idMatches = universe.filter((candidate) => candidate.id.startsWith(prefix));
    const conflictingName = universe.some((candidate) => candidate.id !== instance.id && candidate.name === prefix);
    if (idMatches.length === 1 && !conflictingName) return prefix;
  }
  return instance.id;
}

function displayName(instance: InstanceSnapshot): string {
  return instance.displayName;
}


function quote(value: string): string {
  return JSON.stringify(value);
}
