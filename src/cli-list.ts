import type { InstanceSnapshot } from "./core/managed-instance.js";
import { uniqueInstanceIdPrefix } from "./human-target.js";

export const MAX_HUMAN_LIST_INSTANCES = 100;
const DEFAULT_WIDTH = 80;
const MIN_WIDTH = 20;
const MAX_WIDTH = 160;
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export interface HumanInstanceListSelection {
  instances: InstanceSnapshot[];
  hiddenStopped: number;
}

export interface HumanInstanceListRenderOptions {
  mode?: "actionable" | "all";
  hiddenStopped?: number;
  totalInstances?: number;
  identityUniverse?: readonly InstanceSnapshot[];
}

/** Keep the typed catalog complete; only the public human default hides history. */
export function selectHumanInstanceList(
  instances: readonly InstanceSnapshot[],
  includeStopped: boolean,
): HumanInstanceListSelection {
  const hiddenStopped = includeStopped ? 0 : instances.filter((instance) => instance.lifecycle === "stopped").length;
  return {
    instances: includeStopped ? [...instances] : instances.filter((instance) => instance.lifecycle !== "stopped"),
    hiddenStopped,
  };
}

/** Bounded plain-text catalog projection for the public human CLI. */
export function renderHumanInstanceList(
  instances: readonly InstanceSnapshot[],
  requestedWidth = DEFAULT_WIDTH,
  options: HumanInstanceListRenderOptions = {},
): string {
  const width = normalizeWidth(requestedWidth);
  const mode = options.mode ?? "all";
  const hiddenStopped = Math.max(0, Math.floor(options.hiddenStopped ?? 0));
  const totalInstances = Math.max(instances.length, Math.floor(options.totalInstances ?? instances.length));
  if (instances.length === 0) {
    if (mode === "actionable" && hiddenStopped > 0) {
      return `${fit("No actionable Alu Dock instances.", width)}\n${fit(`${hiddenStopped} stopped hidden · aludock list --all`, width)}\n${fit("Start one: aludock new", width)}\n`;
    }
    return `${fit(mode === "actionable" ? "No actionable Alu Dock instances." : "No Alu Dock instances.", width)}\n${fit("Start one: aludock new", width)}\n`;
  }

  const ordered = [...instances].sort(compareInstances);
  const identityUniverse = options.identityUniverse ?? instances;
  const visible = ordered.slice(0, MAX_HUMAN_LIST_INSTANCES);
  const heading = mode === "actionable"
    ? `Alu Dock actionable · ${totalInstances}${hiddenStopped > 0 ? ` · ${hiddenStopped} stopped hidden` : ""}`
    : `Alu Dock instances · ${totalInstances} · all records`;
  const lines = [fit(heading, width), ""];
  for (const instance of visible) lines.push(...renderInstance(instance, identityUniverse, width));
  const omitted = totalInstances - visible.length;
  if (omitted > 0) {
    lines.push("", fit(`Showing ${visible.length} of ${totalInstances} · ${omitted} older records omitted`, width));
  }
  if (mode === "actionable" && hiddenStopped > 0) lines.push("", fit("History: aludock list --all", width));
  lines.push("", fit(
    width >= 60
      ? "Next: aludock attach TARGET · aludock status TARGET · aludock stop TARGET"
      : "Next: aludock attach TARGET",
    width,
  ));
  return `${lines.join("\n")}\n`;
}

export function humanListWidth(columns: number | undefined): number {
  return normalizeWidth(columns ?? DEFAULT_WIDTH);
}

export function terminalDisplayWidth(value: string): number {
  let width = 0;
  for (const { segment } of graphemes.segment(value)) width += graphemeWidth(segment);
  return width;
}

function renderInstance(
  instance: InstanceSnapshot,
  identityUniverse: readonly InstanceSnapshot[],
  width: number,
): [string, string] {
  const id = terminalSafe(uniqueInstanceIdPrefix(instance, identityUniverse));
  const state = terminalSafe(`${instance.lifecycle}/${instance.execution}`);
  const generation = `g${Math.max(1, Math.floor(instance.runtimeGeneration))}`;
  const base = `${stateIcon(instance)} ${id} ${state} ${generation}`;
  const tags = decisionTags(instance);
  const sessionName = terminalSafe(instance.name || "(unnamed)");
  const safeName = instance.key === undefined ? sessionName : `[${terminalSafe(instance.key)}] ${sessionName}`;
  const available = Math.max(1, width - terminalDisplayWidth(base) - 1);
  const tagText = tags.length > 0 ? ` · ${tags.join(" · ")}` : "";
  const includeTags = terminalDisplayWidth(tagText) + 8 <= available;
  const nameBudget = Math.max(1, available - (includeTags ? terminalDisplayWidth(tagText) : 0));
  const first = fit(`${base} ${truncateDisplay(safeName, nameBudget)}${includeTags ? tagText : ""}`, width);

  const model = terminalSafe(instance.executor.model
    ? `${instance.executor.model.provider}/${instance.executor.model.id}`
    : "no model");
  const cwd = terminalSafe(instance.cwd || "(no cwd)");
  const bodyWidth = Math.max(1, width - 2);
  const separator = " · ";
  if (bodyWidth <= terminalDisplayWidth(separator) + 2) {
    return [first, fit(`  ${truncateDisplay(model, bodyWidth)}`, width)];
  }
  const availableBody = bodyWidth - terminalDisplayWidth(separator);
  const modelBudget = Math.max(1, Math.min(Math.floor(availableBody * 0.42), availableBody - 1));
  const cwdBudget = Math.max(1, availableBody - modelBudget);
  const second = fit(`  ${truncateDisplay(model, modelBudget)}${separator}${truncateDisplay(cwd, cwdBudget)}`, width);
  return [first, second];
}

function decisionTags(instance: InstanceSnapshot): string[] {
  const tags: string[] = [];
  if (instance.pending.total > 0) tags.push(`pending ${instance.pending.total}`);
  if (instance.reopenable && (instance.lifecycle === "host_lost" || instance.lifecycle === "runtime_error")) tags.push("reopenable");
  return tags;
}

function stateIcon(instance: InstanceSnapshot): string {
  if (instance.lifecycle === "active" && instance.execution === "running") return "◆";
  if (instance.lifecycle === "active" && instance.execution === "idle") return "●";
  if (instance.lifecycle === "runtime_error") return "!";
  if (instance.lifecycle === "host_lost") return "×";
  if (instance.lifecycle === "stopping") return "◇";
  return "○";
}

function compareInstances(left: InstanceSnapshot, right: InstanceSnapshot): number {
  const priority = instancePriority(left) - instancePriority(right);
  if (priority !== 0) return priority;
  const updated = right.updatedAt.localeCompare(left.updatedAt);
  return updated !== 0 ? updated : left.id.localeCompare(right.id);
}

function instancePriority(instance: InstanceSnapshot): number {
  if (instance.lifecycle === "active" && instance.execution === "running") return 0;
  if (instance.lifecycle === "active") return 1;
  if (instance.lifecycle === "stopping") return 2;
  if (instance.lifecycle === "runtime_error") return instance.reopenable ? 3 : 4;
  if (instance.lifecycle === "host_lost") return instance.reopenable ? 3 : 4;
  return 5;
}

function terminalSafe(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ")
    .replace(/[\u202a-\u202e\u2066-\u2069\ufeff]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim() || "—";
}

function fit(value: string, width: number): string {
  const safeLine = value
    .replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ")
    .replace(/[\u202a-\u202e\u2066-\u2069\ufeff]/gu, " ");
  return truncateDisplay(safeLine, width);
}

function truncateDisplay(value: string, width: number): string {
  const bounded = Math.max(0, Math.floor(width));
  if (bounded === 0) return "";
  if (terminalDisplayWidth(value) <= bounded) return value;
  if (bounded === 1) return "…";
  const target = bounded - 1;
  let output = "";
  let used = 0;
  for (const { segment } of graphemes.segment(value)) {
    const segmentWidth = graphemeWidth(segment);
    if (used + segmentWidth > target) break;
    output += segment;
    used += segmentWidth;
  }
  return `${output}…`;
}

function graphemeWidth(value: string): number {
  let width = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0) as number;
    if (/\p{Mark}/u.test(character) || codePoint === 0x200d || (codePoint >= 0xfe00 && codePoint <= 0xfe0f)) continue;
    width = Math.max(width, isWide(codePoint, character) ? 2 : 1);
  }
  return width;
}

function isWide(codePoint: number, character: string): boolean {
  if (/\p{Extended_Pictographic}/u.test(character)) return true;
  return codePoint >= 0x1100 && (
    codePoint <= 0x115f
    || codePoint === 0x2329
    || codePoint === 0x232a
    || (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f)
    || (codePoint >= 0xac00 && codePoint <= 0xd7a3)
    || (codePoint >= 0xf900 && codePoint <= 0xfaff)
    || (codePoint >= 0xfe10 && codePoint <= 0xfe19)
    || (codePoint >= 0xfe30 && codePoint <= 0xfe6f)
    || (codePoint >= 0xff00 && codePoint <= 0xff60)
    || (codePoint >= 0xffe0 && codePoint <= 0xffe6)
    || (codePoint >= 0x1f1e6 && codePoint <= 0x1f1ff)
    || (codePoint >= 0x20000 && codePoint <= 0x3fffd)
  );
}

function normalizeWidth(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_WIDTH;
  return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.floor(value)));
}
