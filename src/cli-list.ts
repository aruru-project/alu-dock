import type { InstanceSnapshot } from "./core/managed-instance.js";
import { humanInstanceStatus } from "./core/instance-display-name.js";
import { humanRelativeTime } from "./human-time.js";

const MAX_HUMAN_LIST_INSTANCES = 100;
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
      return `${fit("No work is ready to continue.", width)}\n${fit(`${hiddenStopped} in History · aludock list --all`, width)}\n${fit("Start work: aludock new", width)}\n`;
    }
    return `${fit(mode === "actionable" ? "No work is ready to continue." : "No work in Alu Dock.", width)}\n${fit("Start work: aludock new", width)}\n`;
  }

  const ordered = [...instances].sort(compareInstances);
  const visible = ordered.slice(0, MAX_HUMAN_LIST_INSTANCES);
  const heading = mode === "actionable"
    ? `Alu Dock work · ${totalInstances}${hiddenStopped > 0 ? ` · ${hiddenStopped} in History hidden` : ""}`
    : `Alu Dock work · ${totalInstances} · current and History`;
  const lines = [fit(heading, width), ""];
  for (const instance of visible) lines.push(...renderInstance(instance, width));
  const omitted = totalInstances - visible.length;
  if (omitted > 0) {
    lines.push("", fit(`Showing ${visible.length} of ${totalInstances} · ${omitted} older work item${omitted === 1 ? "" : "s"} not shown`, width));
  }
  if (mode === "actionable" && hiddenStopped > 0) lines.push("", fit("History: aludock list --all", width));
  lines.push("", fit("Open the Hub to choose work: aludock", width));
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

function renderInstance(instance: InstanceSnapshot, width: number): [string, string] {
  const state = terminalSafe(humanInstanceStatus(instance.lifecycle, instance.execution));
  const safeName = terminalSafe(instance.displayName);
  const tags = [state, ...decisionTags(instance)];
  const first = fit(`${stateIcon(instance)} ${safeName} · ${tags.join(" · ")}`, width);

  const model = terminalSafe(instance.executor.model
    ? `${instance.executor.model.provider}/${instance.executor.model.id}`
    : "no model selected");
  const cwd = terminalSafe(instance.cwd || "(project unavailable)");
  const second = fit(`  ${humanRelativeTime(instance.updatedAt)} · ${cwd} · ${model}`, width);
  return [first, second];
}

function decisionTags(instance: InstanceSnapshot): string[] {
  const tags: string[] = [];
  if (instance.pending.total > 0) tags.push(`${instance.pending.total} waiting`);
  if (instance.reopenable && (instance.lifecycle === "host_lost" || instance.lifecycle === "runtime_error")) tags.push("saved session ready");
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
