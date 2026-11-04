import {
  type InstanceObservation,
  type ObservationMessage,
  type ObservationNotification,
  type ObservationResult,
  type ObservedInstanceStatus,
} from "../core/instance-observation.js";
import type { DockToolsResult, ChildModelList } from "../core/dock-tools.js";
import { modelLabel } from "../core/instance-display-name.js";
import { MAX_MODEL_ID_CHARS, MAX_MODEL_PROVIDER_CHARS } from "../control/protocol.js";

/** What the Worker's Pi knows about a model it can run now. */
export interface DescribedModel {
  provider: string;
  id: string;
  thinkingLevels: readonly string[];
  contextWindow?: number;
  images: boolean;
}

/** The Worker's own model and how to look up any other model it can run. */
export interface ModelFacts {
  current?: DescribedModel;
  describe(model: { provider: string; id: string }): DescribedModel | undefined;
}

/** What the Worker knows beyond the Host's result: its models, and the thinking level a new child Work was meant to get. */
export interface RenderContext {
  facts?: ModelFacts;
  thinkingAsked?: string;
}

/** Agent-facing client projection. Structured Host DTOs stay in tool details, never in model-visible text. */
export function renderDockToolsResult(result: DockToolsResult, context: RenderContext = {}): string {
  if (result.type === "models") return renderChildModels(result, context.facts ?? { describe: () => undefined });
  if (result.type === "spawn") {
    const used = result.instance.thinkingLevel;
    const nearest = context.thinkingAsked === undefined || used === undefined || used === context.thinkingAsked
      ? "" : ` Its model has no thinking level ${context.thinkingAsked}, so it runs at ${used}, the nearest it has.`;
    return `Created child Work ${statusLine(result.instance, new Date().toISOString())}.${nearest} ${result.error ?? "It is working on the task; its final reply will be delivered to you when it finishes."}`;
  }
  if (result.type === "interrupt" || result.type === "stop") return `${result.type === "interrupt" ? "Interrupted current turn of" : "Stopped"} ${identity(result.instance)}.`;
  if (result.type === "system_catalog") {
    const catalog = result.result;
    const lines = ["[Dock systems]"];
    for (const candidate of catalog.candidates) lines.push(`│ id=${candidate.id} · ${inline(candidate.name)} · ${candidate.kind} · ${inline(candidate.path, 500)}${candidate.warning ? ` · ${inline(candidate.warning, 500)}` : ""}`);
    for (const warning of catalog.warnings) lines.push(`│ warning: ${inline(warning, 500)}`);
    if (catalog.defaultSelection) lines.push(`Directory default id=${catalog.defaultSelection.id}`);
    if (catalog.nextCursor) lines.push(`Read more with dock_system cursor=${JSON.stringify(catalog.nextCursor)}`);
    return lines.join("\n");
  }
  if (result.type === "system_content") {
    const page = result.result;
    return "[System source]\n"
      + page.text.replace(/\r\n?|[\u2028\u2029]/gu, "\n").split("\n").map((line) => `│ ${line}`).join("\n")
      + "\n[end system source]"
      + (page.nextOffset === undefined ? "" : `\nContinue dock_system with offset=${page.nextOffset} revision=${JSON.stringify(page.revision)}`);
  }
  if (result.type === "machines") {
    const lines = ["[Dock Machines]"];
    for (const machine of result.machines) {
      const role = machine.kind === "main" ? "Main" : "SubHost";
      const platform = machine.platform === "windows" ? "Windows" : machine.platform === "linux" ? "Linux" : "Platform unavailable";
      const home = machine.homePath === undefined ? "Home unavailable" : `Home=${inline(machine.homePath, 180)}`;
      const roots = machine.workspaceRoots === undefined ? "roots unavailable" : `roots=${machine.workspaceRoots.map((root) => inline(root, 180)).join(", ")}`;
      lines.push(`- ${inline(machine.name)} · ${role} · ${platform} · ${machine.available ? "online" : "offline"} · ${home} · ${roots}`);
    }
    return lines.join("\n");
  }
  if (result.type === "deliver") {
    return `Made ${inline(result.deliverable.name)} available for temporary download (${result.deliverable.sizeBytes} bytes). The source file must remain unchanged and available.`;
  }
  if (result.type === "create") {
    return `${result.defaultSaved ? "Directory default saved. " : ""}Created ${identity(result.instance)} in ${inline(result.instance.cwd, 180)}. Collaboration tools are available in the new work.`;
  }
  if (result.type === "send") {
    return `Sent a Dock message to ${identity(result.target)}${result.receipt.queued ? "; it is waiting in that instance’s Queue" : ""}. The message carries your worker identity.${result.error !== undefined ? ` ${result.error}` : result.target.parentId === undefined ? "" : " Its reply will be delivered to you when it finishes."}`;
  }
  return renderObservationResult(result);
}

export function renderObservationResult(result: ObservationResult): string {
  if (result.type === "list") {
    const scope = result.result.includesHistory ? "all catalog records" : "live";
    const lines = [`[Dock Works · ${scope}]`];
    for (const status of result.result.instances) lines.push(`- ${statusLine(status, result.result.observedAt)}`);
    if (result.result.instances.length === 0) lines.push("- none");
    if (result.result.truncated) lines.push(`[… ${result.result.total - result.result.instances.length} more omitted]`);
    return lines.join("\n");
  }
  if (result.type === "inspect") return renderObservation(result.result);
  if (result.type === "cancel") {
    return result.cancelledWatchIds.length === 0
      ? "No active or pending Dock watch matched the cancellation request."
      : `Cancelled Dock watch${result.cancelledWatchIds.length === 1 ? "" : "es"}: ${result.cancelledWatchIds.map(inline).join(", ")}`;
  }
  if (result.status === "watching") {
    return `Watching ${identity(result.receipt.target)} until it becomes idle, stops, or errors. watchId=${inline(result.receipt.watchId)}`;
  }
  return renderObservationNotification(result.completion, false);
}

export function renderObservationNotification(notification: ObservationNotification, wake = true): string {
  const prefix = wake ? "Dock watch completed" : "Dock watch already complete";
  const header = `[${prefix} · target=${quotedIdentity(notification.target)} · reason=${notification.reason} · fired=${notification.firedAt}]`;
  return notification.target.reply === undefined
    ? `${header}\nUse dock_inspect to read what it said.`
    : `${header}\nIts final reply:\n${notification.target.reply}`;
}

/** What dock_wait saw: the replies it took, and why it stopped waiting. */
export interface ChildWaitResult {
  replies: ObservationNotification[];
  /** Child Works that still owe a reply. */
  waiting: ObservedInstanceStatus[];
  ended: "replied" | "nothing_pending" | "message" | "timeout" | "cancelled";
  timeoutSeconds?: number;
}

export function renderChildWait(result: ChildWaitResult): string {
  const head = {
    replied: `${result.replies.length === 1 ? "A child Work replied" : `${result.replies.length} child Works replied`}.`,
    nothing_pending: "No child Work reply is pending: every child Work you handed work to has already replied or stopped.",
    message: "Stopped waiting because a message reached you; it follows this result.",
    timeout: `Stopped waiting after ${result.timeoutSeconds} seconds.`,
    cancelled: "Stopped waiting.",
  }[result.ended];
  const still = result.waiting.length === 0 ? "" : `\nStill working: ${result.waiting.map(quotedIdentity).join(", ")}`;
  return [head + still, ...result.replies.map((notification) => renderObservationNotification(notification))].join("\n\n");
}

/** Your own model first, then the models the user picked, with what each supports. */
function renderChildModels(list: ChildModelList, facts: ModelFacts): string {
  const key = (model: { provider: string; id: string }) => `${model.provider}/${model.id}`;
  const lines: string[] = [];
  if (facts.current) lines.push(`Your model, which child Works use unless you are asked for another: ${describeModel(facts.current)}`);
  const listed = list.models.filter((model) => !facts.current || key(model) !== key(facts.current));
  const available = listed.flatMap((model) => { const described = facts.describe(model); return described ? [described] : []; });
  const unavailable = listed.filter((model) => !facts.describe(model)).map(key);
  if (available.length > 0) {
    lines.push("", "Models the user picked for child Works:");
    for (const described of available) lines.push(`- ${describeModel(described)}`);
  }
  if (unavailable.length > 0) lines.push("", `Listed but not available on this machine now: ${unavailable.join(", ")}.`);
  if (list.problem) lines.push("", `The user's list of models for child Works could not be used: ${list.problem}. Tell the user if they expect one.`);
  else if (list.models.length === 0) lines.push("", "The user has not listed models for child Works.");
  lines.push("", "Set model only when the user or the project's instructions ask for one; this list gives its exact name. A model the user names that is not listed also works.");
  return lines.join("\n");
}

function describeModel(model: DescribedModel): string {
  const thinking = model.thinkingLevels.length === 1 && model.thinkingLevels[0] === "off" ? "no thinking levels" : `thinking ${model.thinkingLevels.join(", ")}`;
  const context = model.contextWindow === undefined ? "" : ` · context ${tokenCount(model.contextWindow)}`;
  return `${model.provider}/${model.id} · ${thinking}${context} · ${model.images ? "reads images" : "text only"}`;
}

function tokenCount(tokens: number): string {
  if (tokens >= 1_000_000) return `${Number((tokens / 1_000_000).toFixed(2))}M tokens`;
  return `${Math.round(tokens / 1_000)}K tokens`;
}

function renderObservation(observation: InstanceObservation): string {
  const lines = [
    `[Dock conversation excerpt · source=${quotedIdentity(observation.status)}]`,
    `status: ${statusLine(observation.status, observation.observedAt)}`,
  ];
  const page = observation.conversation;
  if (!page || page.messages.length === 0) {
    lines.push("", "[no matching conversation messages]");
  } else {
    for (const message of page.messages) lines.push("", renderMessage(message));
  }
  const suffix: string[] = [];
  if (page?.hasEarlier) suffix.push("earlier messages available");
  lines.push("", `[end excerpt${suffix.length === 0 ? "" : ` · ${suffix.join(" · ")}`}]`);
  if (page?.nextCursor) lines.push(`continuation cursor: ${inline(page.nextCursor)}`);
  return lines.join("\n");
}

function renderMessage(message: ObservationMessage): string {
  const label = message.type === "user" ? "target_user" : message.type === "assistant" ? "target_assistant" : "target_other";
  const heading = `${label}${message.timestamp === undefined ? "" : ` · ${message.timestamp}`}`;
  const quoted = message.text.replace(/\r\n?|[\u2028\u2029]/gu, "\n").split("\n").map((line) => `│ ${line}`).join("\n");
  return `${heading}\n${quoted}`;
}

function statusLine(status: ObservedInstanceStatus, observedAt: string): string {
  const state = status.compacting ? "compacting" : status.execution;
  const duration = status.runStartedAt === undefined ? "" : ` · running ${elapsed(status.runStartedAt, observedAt)}`;
  const error = status.lastError === undefined ? "" : ` · error=${inline(status.lastError, 160)}`;
  // The whole model name: the provider says whose account pays, and family members differ only at the end.
  const label = inline(modelLabel(status.model), MAX_MODEL_PROVIDER_CHARS + 1 + MAX_MODEL_ID_CHARS);
  const model = status.model === undefined ? ` · ${label}` : ` · model=${label}`;
  const thinking = status.thinkingLevel === undefined ? "" : ` · thinking=${status.thinkingLevel}`;
  return `${identity(status)}${status.parentId ? ` · parent=${inline(status.parentId)}` : ""} · ${status.lifecycle}/${state}${duration}${model}${thinking} · cwd=${inline(status.cwd, 180)}${error}`;
}

function identity(status: ObservedInstanceStatus): string {
  const label = status.name ?? status.key ?? status.id;
  const key = status.key && status.key !== label ? ` key=${inline(status.key)}` : "";
  return `${inline(label)}${key} id=${inline(status.id)}`;
}

function quotedIdentity(status: ObservedInstanceStatus): string {
  return `"${identity(status).replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function elapsed(start: string, end: string): string {
  const milliseconds = Math.max(0, Date.parse(end) - Date.parse(start));
  if (!Number.isFinite(milliseconds)) return "unknown";
  const seconds = Math.floor(milliseconds / 1_000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function inline(value: string, max = 256): string {
  const safe = value.replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ").replace(/\s+/gu, " ").trim();
  return safe.length <= max ? safe : `${safe.slice(0, Math.max(0, max - 1))}…`;
}
