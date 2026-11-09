import {
  type InstanceObservation,
  type ObservationMessage,
  type ObservationNotification,
  type ObservationResult,
  type ObservedInstanceStatus,
} from "../core/instance-observation.js";
import { MAX_CHILD_LAST_WORDS_CHARS, type DockToolsResult, type ChildModelList, type ChildStopReason, type WorkMessage } from "../core/dock-tools.js";
import { modelLabel } from "../core/instance-display-name.js";
import { MAX_MODEL_ID_CHARS, MAX_MODEL_PROVIDER_CHARS } from "../control/protocol.js";
import type { ChildWaitResult } from "./child-messages.js";

/**
 * A message between a Work and its parent or child Work in the conversation (card #666). The model reads it
 * as user text, so its first line says whose words it is; clients show it as a message from that Work.
 */
export const WORK_MESSAGE_TYPE = "dock-work-message";
/** Hidden marker that starts a turn for Work messages an idle Work just took; the model never reads it. */
export const WORK_WAKE_TYPE = "dock-work-wake";

/** What clients use to style a Work message; its first line already says it to the model and the reader. */
export interface WorkMessageDetails {
  from: "parent" | "child";
  done?: true;
  stopped?: true;
}

const CHILD_STOP_REASONS: Record<ChildStopReason, string> = {
  ended: "没有把结果发给你就结束了这一轮",
  aborted: "这一轮被中断了",
  failed: "这一轮出错停下了",
  stopped: "被停止了",
  crashed: "崩溃了",
};

/** The first line of a Work message: who it is from, and whether it is a final result. */
export function workMessageSourceLine(message: WorkMessage): string {
  const name = inline(message.from.name);
  if (message.type === "child_stopped") return `[子 Work「${name}」异常停止]`;
  if (message.from.relation === "parent") return `[来自父 Work「${name}」]`;
  return message.done ? `[来自子 Work「${name}」· 已完成]` : `[来自子 Work「${name}」]`;
}

export function renderWorkMessage(message: WorkMessage): string {
  const head = workMessageSourceLine(message);
  if (message.type === "message") return `${head}\n${message.text}`;
  const lines = [head, `原因：${CHILD_STOP_REASONS[message.reason]}${message.error ? `：${inline(message.error, MAX_CHILD_LAST_WORDS_CHARS)}` : ""}`];
  // A blank line ends the quote, so what follows is not read as the child Work's words.
  if (message.lastWords !== undefined) lines.push("它最后说的话：", ...message.lastWords.replace(/\r\n?|[\u2028\u2029]/gu, "\n").split("\n").map((line) => `> ${line}`), "");
  lines.push(message.reason === "stopped" || message.reason === "crashed"
    ? "它已经停下，不会再回复；它的对话记录留在磁盘上。"
    : "它还欠你结果。用 dock_inspect 看它做到哪了；要它接着做，用 dock_send 发消息给它；不再需要就用 dock_stop 停掉它。");
  return lines.join("\n");
}

/** The custom message Pi records for a dock_watch notice. */
export function watchNoticeEntry(notification: ObservationNotification): { customType: string; content: string; display: true; details: ObservationNotification } {
  return { customType: "dock-tools-watch", content: renderObservationNotification(notification), display: true, details: notification };
}

/** The custom message Pi records for a Work message. */
export function workMessageEntry(message: WorkMessage): { customType: string; content: string; display: true; details: WorkMessageDetails } {
  const details: WorkMessageDetails = {
    from: message.from.relation,
    ...(message.type === "message" && message.done ? { done: true as const } : {}),
    ...(message.type === "child_stopped" ? { stopped: true as const } : {}),
  };
  return { customType: WORK_MESSAGE_TYPE, content: renderWorkMessage(message), display: true, details };
}

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
    return `Created child Work ${statusLine(result.instance, new Date().toISOString())}.${nearest} ${result.error ?? "It is working on the task. Its final result reaches you as a message from it, at your next step if you are still working."}`;
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
      const here = machine.hostId === result.currentHostId ? " (this Work's Machine)" : "";
      lines.push(`- ${inline(machine.name)}${here} · ${role} · ${platform} · ${machine.available ? "online" : "offline"} · ${home} · ${roots}`);
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
    return `Sent a Dock message to ${identity(result.target)}${result.receipt.queued ? "; it is waiting in that instance’s Queue" : ""}. The message carries your worker identity.${result.error === undefined ? "" : ` ${result.error}`}`;
  }
  if (result.type === "work_message") {
    if (result.to === "parent") return result.done
      ? "Your final result reached your parent Work. Your turn ends here."
      : "Your message reached your parent Work. Keep working; its answer arrives as a message from it.";
    return `Sent to child Work ${identity(result.target)}; it reads it at its next step. Its answers and its final result reach you as messages from it.`;
  }
  if (result.type === "unreported_stop") return result.notified ? "Your parent Work was told you stopped." : "Nothing was owed to your parent Work.";
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

export function renderChildWait(result: ChildWaitResult): string {
  const received = result.messages.length === 0 ? "" : result.messages.length === 1 ? "A message from a child Work arrived." : `${result.messages.length} messages from child Works arrived.`;
  const head = {
    received,
    nothing_pending: "No child Work owes you a result: every child Work you handed work to has sent its final result or stopped.",
    message: `Stopped waiting because a message reached you; it follows this result.${received ? ` ${received}` : ""}`,
    timeout: `Stopped waiting after ${result.timeoutSeconds} seconds.${received ? ` ${received}` : ""}`,
    cancelled: `Stopped waiting.${received ? ` ${received}` : ""}`,
  }[result.ended];
  const still = result.waiting.length === 0 ? "" : `\nStill working: ${result.waiting.map((child) => `"${inline(child.name)}" id=${inline(child.id)}`).join(", ")}`;
  return [head + still, ...result.messages.map(renderWorkMessage)].join("\n\n");
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
