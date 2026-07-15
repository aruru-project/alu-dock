import {
  Markdown,
  truncateToWidth,
  wrapTextWithAnsi,
  type Component,
} from "@earendil-works/pi-tui";

import type { DockEvent, HistoryEntryDto, InstanceSnapshot } from "../core/managed-instance.js";
import { markdownTheme, paint } from "./theme.js";

type EntryKind = "user" | "assistant" | "thinking" | "tool" | "system" | "error";

interface ConversationEntry {
  kind: EntryKind;
  text: string;
  complete: boolean;
  diffText?: string;
}

interface ToolProjection {
  entry: ConversationEntry;
  name: string;
  args?: string;
  output?: string;
  omitted: string[];
}

const MAX_ENTRIES = 200;
const MAX_TOOL_OUTPUT = 8_000;
const MAX_TOOL_ARGS = 4_000;

/** Event-to-chat projection shared by replay, live TUI updates, and deterministic tests. */
export class DockConversation implements Component {
  private readonly entries: ConversationEntry[] = [];
  private readonly tools = new Map<string, ToolProjection>();
  private currentAssistant: ConversationEntry | undefined;
  private currentThinking: ConversationEntry | undefined;
  private queueEntry: ConversationEntry | undefined;
  private hideThinking = false;
  private toolsExpanded = true;
  private outputPadding = 1;

  reset(): void {
    this.entries.length = 0;
    this.tools.clear();
    this.currentAssistant = undefined;
    this.currentThinking = undefined;
    this.queueEntry = undefined;
  }

  applyHistory(entries: HistoryEntryDto[], truncated: boolean): void {
    if (truncated) this.add("system", "Earlier session history is available through paged history.");
    for (const entry of entries) {
      const thinking = contentText(entry.content, "thinking");
      const text = contentText(entry.content, "text");
      if (entry.role === "user") {
        this.add("user", text ?? historyOmissions(entry));
      } else if (entry.role === "assistant") {
        if (!this.hideThinking && thinking) this.add("thinking", thinking);
        if (text) this.add("assistant", text);
        for (const block of entry.content) {
          if (block.type !== "tool_call") continue;
          const projected: ToolProjection = {
            entry: this.add("tool", "", true),
            name: block.toolName,
            args: formatJson(block.args, MAX_TOOL_ARGS),
            omitted: [...(block.omittedFields ?? [])],
          };
          this.updateTool(projected, "done");
        }
        if (entry.error) this.add("error", entry.error);
      } else if (entry.role === "tool") {
        for (const block of entry.content) {
          if (block.type !== "tool_result") continue;
          const projected: ToolProjection = {
            entry: this.add(block.isError ? "error" : "tool", "", true),
            name: block.toolName,
            output: block.text,
            omitted: [...(block.omittedFields ?? [])],
          };
          this.updateTool(projected, block.isError ? "failed" : "done");
          projected.entry.diffText = !block.isError && looksLikeDiff(block.text) ? block.text : undefined;
        }
      } else {
        this.add(entry.error ? "error" : "system", text || historyOmissions(entry) || entry.error || "Session event");
      }
    }
  }

  applyReplay(events: DockEvent[], truncated: boolean): void {
    if (truncated) this.add("system", "Earlier activity is outside the host's recent-event window.");
    for (const event of events) this.apply(event);
  }

  apply(event: DockEvent): void {
    switch (event.type) {
      case "message.submitted":
        this.add("user", stringData(event, "text") ?? "");
        break;

      case "message.delta": {
        const delta = event.data.delta;
        if (!delta) break;
        if (event.data.block === "thinking") {
          if (this.hideThinking) break;
          this.currentThinking ??= this.add("thinking", "", false);
          this.currentThinking.text += safeTerminalText(delta);
        } else {
          this.currentAssistant ??= this.add("assistant", "", false);
          this.currentAssistant.text += safeTerminalText(delta);
        }
        break;
      }

      case "message.completed": {
        const role = stringData(event, "role");
        if (role !== "assistant") break;
        const text = contentText(event.data.content, "text");
        const thinking = contentText(event.data.content, "thinking");
        if (!this.hideThinking && (this.currentThinking || thinking)) {
          const entry = this.currentThinking ?? this.add("thinking", "", false);
          if (thinking !== undefined) entry.text = safeTerminalText(thinking);
          entry.complete = true;
        }
        this.currentThinking = undefined;

        // Failed transport attempts can complete without assistant text. Retry
        // events own intermediate noise and run.settled owns the final error.
        const entry = this.currentAssistant ?? (text ? this.add("assistant", "", false) : undefined);
        if (entry) {
          if (text !== undefined) entry.text = safeTerminalText(text);
          entry.complete = true;
        }
        this.currentAssistant = undefined;
        break;
      }

      case "tool.started": {
        const name = stringData(event, "toolName") ?? "tool";
        const callId = stringData(event, "toolCallId") ?? `${event.sequence}`;
        const projected: ToolProjection = {
          entry: this.add("tool", "", false),
          name,
          args: formatJson(event.data.args, MAX_TOOL_ARGS),
          omitted: [...(event.data.omittedFields ?? [])],
        };
        this.tools.set(callId, projected);
        this.updateTool(projected, "running");
        break;
      }

      case "tool.args_updated": {
        const callId = stringData(event, "toolCallId") ?? `${event.sequence}`;
        const tool = this.tools.get(callId);
        if (!tool) break;
        tool.args = formatJson(event.data.args, MAX_TOOL_ARGS);
        tool.omitted = [...(event.data.omittedFields ?? [])];
        this.updateTool(tool, "running");
        break;
      }

      case "tool.output_updated": {
        const callId = stringData(event, "toolCallId") ?? `${event.sequence}`;
        const tool = this.tools.get(callId);
        if (!tool) break;
        tool.output = truncate(stringData(event, "text") ?? "", MAX_TOOL_OUTPUT);
        this.updateTool(tool, "running");
        break;
      }

      case "tool.completed": {
        const name = stringData(event, "toolName") ?? "tool";
        const callId = stringData(event, "toolCallId") ?? `${event.sequence}`;
        const tool = this.tools.get(callId) ?? {
          entry: this.add("tool", "", false),
          name,
          omitted: [],
        };
        tool.name = name;
        tool.output = truncate(stringData(event, "text") ?? "", MAX_TOOL_OUTPUT);
        tool.omitted = [...new Set([...tool.omitted, ...(event.data.omittedFields ?? [])])];
        const isError = event.data.isError === true;
        tool.entry.kind = isError ? "error" : "tool";
        tool.entry.complete = true;
        this.updateTool(tool, isError ? "failed" : "done");
        tool.entry.diffText = !isError && looksLikeDiff(tool.output) ? tool.output : undefined;
        this.tools.delete(callId);
        break;
      }

      case "queue.changed": {
        const total = event.data.total;
        const text = total > 0
          ? `Queue · ${event.data.steering} steering · ${event.data.followUp} follow-up`
          : "Queue drained.";
        if (this.queueEntry) this.queueEntry.text = text;
        else this.queueEntry = this.add("system", text);
        if (total === 0) this.queueEntry = undefined;
        break;
      }

      case "queue.cleared":
        this.add("system", `Queue cleared · ${event.data.total} removed.`);
        this.queueEntry = undefined;
        break;

      case "model.changed": {
        const provider = stringData(event, "provider") ?? "unknown";
        const id = stringData(event, "id") ?? "unknown";
        const thinking = stringData(event, "thinkingLevel");
        this.add("system", `Model changed to ${provider}/${id}${thinking ? ` · thinking ${thinking}` : ""}.`);
        break;
      }

      case "thinking.changed":
        this.add("system", `Thinking level: ${stringData(event, "thinkingLevel") ?? "unknown"}.`);
        break;

      case "run.retry_started":
        this.add("system", `Retrying (${numberData(event, "attempt") ?? "?"}/${numberData(event, "maxAttempts") ?? "?"}) in ${numberData(event, "delayMs") ?? 0}ms…`);
        break;

      case "run.retry_completed":
        this.add(event.data.success ? "system" : "error", event.data.success ? `Retry ${event.data.attempt} resumed.` : event.data.error ?? "Retry failed.");
        break;

      case "compaction.started":
        this.add("system", `Compacting context · ${event.data.reason}.`);
        break;

      case "compaction.completed":
        this.add(event.data.error ? "error" : "system", event.data.error ?? `Compaction ${event.data.aborted ? "aborted" : "completed"}${event.data.willRetry ? " · retrying" : ""}.`);
        break;

      case "run.settled": {
        const result = stringData(event, "result");
        if (this.currentAssistant) this.currentAssistant.complete = true;
        if (this.currentThinking) this.currentThinking.complete = true;
        this.currentAssistant = undefined;
        this.currentThinking = undefined;
        for (const tool of this.tools.values()) {
          tool.entry.complete = true;
          this.updateTool(tool, result === "succeeded" ? "done" : "failed");
          if (result !== "succeeded") tool.entry.text += `\ninterrupted by ${result ?? "settlement"}`;
        }
        this.tools.clear();
        if (result === "failed") this.add("error", stringData(event, "error") ?? "Run failed");
        else if (result === "aborted") this.add("system", "Run aborted.");
        break;
      }

      case "session.replaced":
        if (this.currentAssistant) this.currentAssistant.complete = true;
        if (this.currentThinking) this.currentThinking.complete = true;
        for (const tool of this.tools.values()) {
          tool.entry.complete = true;
          this.updateTool(tool, "failed");
          tool.entry.text += "\ninterrupted by session replacement";
        }
        this.add("system", `Session ${event.data.reason} · generation ${event.data.runtimeGeneration}.`);
        this.currentAssistant = undefined;
        this.currentThinking = undefined;
        this.tools.clear();
        break;

      case "command.handled":
        this.add("system", "Command handled without starting a model run.");
        break;

      case "command.rejected":
      case "instance.error":
      case "instance.runtime_error":
      case "extension.error":
      case "settings.write_failed":
        this.add("error", stringData(event, "error") ?? event.type);
        break;

      case "extension.notification":
        this.add(event.data.level === "error" ? "error" : "system", event.data.message);
        break;

      case "resources.reloaded":
        this.add("system", `Resources reloaded · ${event.data.resources.length} items · ${event.data.diagnostics.length} diagnostics.`);
        break;

      case "instance.stopped":
        this.add("system", "Instance stopped.");
        break;

      default:
        break;
    }
  }

  addNotice(text: string, error = false): void {
    this.add(error ? "error" : "system", text);
  }

  setHideThinking(hidden: boolean): void {
    this.hideThinking = hidden;
    if (hidden && this.currentThinking) {
      this.currentThinking.complete = true;
      this.currentThinking = undefined;
    }
  }
  setOutputPadding(padding: number): void { this.outputPadding = Math.max(0, Math.min(3, Math.floor(padding))); }
  toggleToolsExpanded(): boolean { this.toolsExpanded = !this.toolsExpanded; return this.toolsExpanded; }
  areToolsExpanded(): boolean { return this.toolsExpanded; }

  invalidate(): void {}

  render(width: number): string[] {
    if (this.entries.length === 0) return [paint.muted("  Start a conversation below.")];

    const indent = " ".repeat(this.outputPadding + 1);
    const contentWidth = Math.max(1, width - visibleIndentWidth(indent));
    const lines: string[] = [];
    for (const entry of this.entries) {
      if (this.hideThinking && entry.kind === "thinking") continue;
      lines.push(truncateToWidth(`${indent}${label(entry.kind, entry.complete)}`, width));
      for (const line of this.renderEntry(entry, contentWidth)) {
        lines.push(truncateToWidth(`${indent}${line}`, width));
      }
      lines.push("");
    }
    return lines;
  }

  /** Plain projection used by deterministic tests and non-TTY validation. */
  snapshot(): ReadonlyArray<{ kind: EntryKind; text: string; complete: boolean }> {
    return this.entries.map(({ kind, text, complete }) => ({ kind, text, complete }));
  }

  private renderEntry(entry: ConversationEntry, width: number): string[] {
    if (entry.kind === "tool" && !this.toolsExpanded) {
      const [title = "Tool"] = entry.text.split("\n");
      return [truncateToWidth(`${title} ${paint.muted("· Ctrl+O expand")}`, width)];
    }
    if (entry.diffText) {
      const marker = "\nresult\n";
      const markerIndex = entry.text.indexOf(marker);
      const details = (markerIndex >= 0 ? entry.text.slice(0, markerIndex) : entry.text.split("\n")[0] ?? "tool done").split("\n");
      return [...details, ...renderDockDiff(entry.diffText)].map((line) => truncateToWidth(line, width));
    }
    if (entry.kind === "assistant" || entry.kind === "thinking") {
      const text = entry.text.length > 0 ? entry.text : "…";
      const markdown = new Markdown(
        text,
        0,
        0,
        markdownTheme,
        entry.kind === "thinking" ? { color: paint.muted, italic: true } : undefined,
      );
      return markdown.render(width);
    }
    const text = entry.text.length > 0 ? entry.text : "…";
    return text.split("\n").flatMap((line) => wrapTextWithAnsi(line || " ", width));
  }

  private updateTool(tool: ToolProjection, state: "running" | "done" | "failed"): void {
    const parts = [`${tool.name} ${state}`];
    if (tool.args) parts.push(`args\n${tool.args}`);
    if (tool.omitted.length > 0) parts.push(`omitted: ${tool.omitted.join(", ")}`);
    if (tool.output) parts.push(`result\n${tool.output}`);
    tool.entry.text = safeTerminalText(parts.join("\n"));
  }

  private add(kind: EntryKind, text: string, complete = true): ConversationEntry {
    const entry: ConversationEntry = { kind, text: safeTerminalText(text), complete };
    this.entries.push(entry);
    while (this.entries.length > MAX_ENTRIES) {
      const removed = this.entries.shift();
      if (removed === this.currentAssistant) this.currentAssistant = undefined;
      if (removed === this.currentThinking) this.currentThinking = undefined;
      if (removed === this.queueEntry) this.queueEntry = undefined;
      for (const [key, value] of this.tools) if (value.entry === removed) this.tools.delete(key);
    }
    return entry;
  }
}

export class DockStatusLine implements Component {
  private snapshotValue: InstanceSnapshot;
  private activity = "ready";
  private connection = "connected";
  private controller = "observing";
  private autoCompaction: boolean | undefined;

  constructor(snapshot: InstanceSnapshot) { this.snapshotValue = snapshot; }
  update(snapshot: InstanceSnapshot): void { this.snapshotValue = snapshot; }
  setActivity(activity: string): void { this.activity = safeTerminalText(activity); }
  setConnection(connection: string): void { this.connection = safeTerminalText(connection); }
  setController(controller: string): void { this.controller = safeTerminalText(controller); }
  setAutoCompaction(enabled: boolean | undefined): void { this.autoCompaction = enabled; }
  invalidate(): void {}

  render(width: number): string[] {
    const snapshot = this.snapshotValue;
    const model = snapshot.executor.model ? `${safeTerminalText(snapshot.executor.model.provider)}/${safeTerminalText(snapshot.executor.model.id)}` : "no model";
    const name = safeTerminalText(snapshot.name || shortId(snapshot.id));
    const state = snapshot.lifecycle === "active" ? snapshot.execution : snapshot.lifecycle;
    const thinking = snapshot.executor.thinkingLevel ? ` · think ${snapshot.executor.thinkingLevel}` : "";
    const pending = snapshot.pending.total > 0 ? ` · queue ${snapshot.pending.total}` : "";
    const identity = `─ ${name} · ${safeTerminalText(snapshot.cwd)}`;
    const runtime = `  dock ${shortId(snapshot.id)} · pi ${shortId(snapshot.executor.piSessionId)} · ${model}${thinking} · ${state}${pending} · ${this.activity} · ${this.connection}/${this.controller}`;
    const metrics = `  ${formatMetrics(snapshot)} · compact ${this.autoCompaction === undefined ? "—" : this.autoCompaction ? "auto" : "manual"}`;
    const lines = [identity, runtime, metrics].map((line) => truncateToWidth(paint.muted(line), width));
    const statuses = Object.entries(snapshot.extensionStatus);
    if (statuses.length > 0) lines.push(truncateToWidth(paint.muted(`  ext · ${statuses.map(([key, value]) => `${safeTerminalText(key)}: ${safeTerminalText(value)}`).join(" · ")}`), width));
    return lines;
  }
}

function label(kind: EntryKind, complete: boolean): string {
  switch (kind) {
    case "user": return paint.user("You");
    case "assistant": return paint.assistant(complete ? "Assistant" : "Assistant · streaming");
    case "thinking": return paint.muted(complete ? "Thinking" : "Thinking · streaming");
    case "tool": return paint.accent(complete ? "Tool" : "Tool · running");
    case "error": return paint.error("Error");
    case "system": return paint.muted("Dock");
  }
}

function formatMetrics(snapshot: InstanceSnapshot): string {
  const metrics = snapshot.metrics;
  if (!metrics) return "tokens — · context — · cache — · cost —";
  const denominator = metrics.tokens.input + metrics.tokens.cacheRead + metrics.tokens.cacheWrite;
  const cache = denominator > 0 ? `${Math.round((metrics.tokens.cacheRead / denominator) * 100)}%` : "—";
  const context = metrics.context
    ? `${formatCount(metrics.context.tokens)}/${formatCount(metrics.context.contextWindow)}${metrics.context.percent === null ? "" : ` ${Math.round(metrics.context.percent)}%`}`
    : "—";
  return `tokens ↑${formatCount(metrics.tokens.input)} ↓${formatCount(metrics.tokens.output)} Σ${formatCount(metrics.tokens.total)} · context ${context} · cache ${cache} · $${metrics.cost.toFixed(4)}`;
}

function formatCount(value: number | null): string {
  if (value === null) return "?";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

function contentText(value: unknown, type: "text" | "thinking"): string | undefined {
  if (!Array.isArray(value)) return undefined;
  const text = value.flatMap((item) => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) return [];
    const block = item as Record<string, unknown>;
    return block.type === type && typeof block.text === "string" ? [block.text] : [];
  }).join("");
  return text || undefined;
}

function historyOmissions(entry: HistoryEntryDto): string {
  return entry.content
    .filter((block): block is Extract<HistoryEntryDto["content"][number], { type: "omitted" }> => block.type === "omitted")
    .map((block) => block.description)
    .join("\n");
}

function formatJson(value: unknown, limit: number): string | undefined {
  try {
    const text = JSON.stringify(value, null, 2);
    return text === undefined || text === "{}" ? undefined : truncate(text, limit);
  } catch {
    return "[unavailable]";
  }
}

function stringData(event: DockEvent, key: string): string | undefined {
  const value = (event.data as unknown as Record<string, unknown>)[key];
  return typeof value === "string" ? safeTerminalText(value) : undefined;
}

function numberData(event: DockEvent, key: string): number | undefined {
  const value = (event.data as unknown as Record<string, unknown>)[key];
  return typeof value === "number" ? value : undefined;
}

function safeTerminalText(text: string): string {
  return text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "");
}

function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}

function looksLikeDiff(text: string | undefined): text is string {
  if (!text) return false;
  return text.startsWith("diff --git ") || (/^--- .+\n\+\+\+ .+/m.test(text) && /^@@ /m.test(text));
}

function renderDockDiff(text: string): string[] {
  return text.split("\n").map((line) => {
    if (line.startsWith("+++ ") || line.startsWith("--- ") || line.startsWith("diff --git ")) return paint.bold(line);
    if (line.startsWith("@@ ")) return paint.accent(line);
    if (line.startsWith("+")) return paint.success(line);
    if (line.startsWith("-")) return paint.error(line);
    return line;
  });
}

function visibleIndentWidth(indent: string): number { return indent.length; }
function shortId(id: string): string { return id.slice(0, 8); }
