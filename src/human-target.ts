import type { InstanceSnapshot } from "./core/managed-instance.js";

export type HumanTargetResolution =
  | { kind: "resolved"; instance: InstanceSnapshot }
  | { kind: "not_found"; target: string; message: string }
  | { kind: "ambiguous"; target: string; candidates: InstanceSnapshot[]; message: string };

/** Names are the public human route; existing exact IDs/prefixes remain accepted for compatibility. Never guess. */
export function resolveHumanTarget(
  instances: readonly InstanceSnapshot[],
  rawTarget: string,
): HumanTargetResolution {
  const target = rawTarget;
  if (target.trim().length === 0) {
    return {
      kind: "not_found",
      target,
      message: "Enter a work name, or run `aludock` to choose work in the Hub.",
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
      message: `No work named ${quote(target)} was found. Run \`aludock\` to choose from current work and History.`,
    };
  }
  return {
    kind: "ambiguous",
    target,
    candidates: matches,
    message: `Several work items match ${quote(target)}. Run \`aludock\` and choose by project and recent activity.`,
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

function quote(value: string): string {
  return JSON.stringify(value);
}
