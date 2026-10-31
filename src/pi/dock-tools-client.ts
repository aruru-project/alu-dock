import {
  type InstanceObservation,
  type ObservationMessage,
  type ObservationNotification,
  type ObservationResult,
  type ObservedInstanceStatus,
} from "../core/instance-observation.js";
import type { DockToolsResult } from "../core/dock-tools.js";
import { modelLabel } from "../core/instance-display-name.js";
import { MAX_MODEL_ID_CHARS, MAX_MODEL_PROVIDER_CHARS } from "../control/protocol.js";

/** Agent-facing client projection. Structured Host DTOs stay in tool details, never in model-visible text. */
export function renderDockToolsResult(result: DockToolsResult): string {
  if (result.type === "models") return result.result.models.map((model) => `${model.provider}/${model.id} · ${model.reasoning ? "reasoning" : "no reasoning"}`).join("\n") || "No configured model is available. Configure a provider in Dock settings.";
  if (result.type === "spawn") return `Created child ${statusLine(result.instance, new Date().toISOString())}. ${result.watchStatus === "failed" ? result.error : result.taskStatus === "accepted" ? `Task accepted; ${result.watchStatus === "completed" ? "already settled, inspect its result" : "completion will notify you"}.` : result.error} Use dock_inspect to read progress and dock_send for follow-up.`;
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
    return `Sent a Dock message to ${identity(result.target)}${result.receipt.queued ? "; it is waiting in that instance’s Queue" : ""}. The message carries your worker identity.`;
  }
  return renderObservationResult(result);
}

export function renderObservationResult(result: ObservationResult): string {
  if (result.type === "list") {
    const scope = result.result.includesHistory ? "all catalog records" : "live siblings";
    const lines = [`[Dock sibling list · ${scope}]`];
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
  return `[${prefix} · target=${quotedIdentity(notification.target)} · reason=${notification.reason} · fired=${notification.firedAt}]\n`
    + "Use dock_inspect to read the result, then continue coordinating the task.";
}

function renderObservation(observation: InstanceObservation): string {
  const lines = [
    `[Dock sibling excerpt · source=${quotedIdentity(observation.status)}]`,
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
