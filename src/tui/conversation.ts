import {
  truncateToWidth,
  wrapTextWithAnsi,
  type Component,
} from "@earendil-works/pi-tui";

import type { DockEvent, InstanceSnapshot } from "../core/managed-instance.js";
import { paint } from "./theme.js";

type EntryKind = "user" | "assistant" | "tool" | "system" | "error";

interface ConversationEntry {
  kind: EntryKind;
  text: string;
  complete: boolean;
}

const MAX_ENTRIES = 200;
const MAX_TOOL_OUTPUT = 1_000;

/** Small event-to-chat projection shared by replay and live TUI updates. */
export class DockConversation implements Component {
  private readonly entries: ConversationEntry[] = [];
  private readonly tools = new Map<string, ConversationEntry>();
  private currentAssistant: ConversationEntry | undefined;

  applyReplay(events: DockEvent[], truncated: boolean): void {
    if (truncated) this.add("system", "Earlier activity is outside the host's recent-event window.");
    for (const event of events) this.apply(event);
  }

  apply(event: DockEvent): void {
    switch (event.type) {
      case "message.submitted":
        this.add("user", stringData(event, "text") ?? "");
        break;

      case "assistant.text_delta": {
        const delta = stringData(event, "delta");
        if (!delta) break;
        if (!this.currentAssistant) {
          this.currentAssistant = this.add("assistant", "", false);
        }
        this.currentAssistant.text += safeTerminalText(delta);
        break;
      }

      case "message.completed": {
        const role = stringData(event, "role");
        const text = stringData(event, "text");
        if (role === "assistant") {
          // Failed transport attempts can complete without any assistant text.
          // Do not render an empty assistant bubble or per-attempt error: retry
          // events describe intermediate attempts and run.settled owns the final error.
          const entry = this.currentAssistant
            ?? (text ? this.add("assistant", "", false) : undefined);
          if (entry) {
            if (text !== undefined) entry.text = safeTerminalText(text);
            entry.complete = true;
          }
          this.currentAssistant = undefined;
        }
        // User input is projected from Dock's canonical message.submitted event.
        // Pi also emits message_end for that same message; rendering both would
        // duplicate one logical prompt during live viewing and replay.
        break;
      }

      case "tool.started": {
        const name = stringData(event, "toolName") ?? "tool";
        const callId = stringData(event, "toolCallId") ?? `${event.sequence}`;
        const entry = this.add("tool", `${name} …`, false);
        this.tools.set(callId, entry);
        break;
      }

      case "tool.completed": {
        const name = stringData(event, "toolName") ?? "tool";
        const callId = stringData(event, "toolCallId") ?? `${event.sequence}`;
        const isError = event.data.isError === true;
        const output = stringData(event, "output");
        const suffix = output ? `\n${truncate(output, MAX_TOOL_OUTPUT)}` : "";
        const entry = this.tools.get(callId) ?? this.add("tool", "", false);
        entry.kind = isError ? "error" : "tool";
        entry.text = `${name} ${isError ? "failed" : "done"}${suffix}`;
        entry.complete = true;
        this.tools.delete(callId);
        break;
      }

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
        this.add("system", `Retrying (${numberData(event, "attempt") ?? "?"}/${numberData(event, "maxAttempts") ?? "?"})…`);
        break;

      case "run.settled": {
        const result = stringData(event, "result");
        if (result === "failed") this.add("error", stringData(event, "error") ?? "Run failed");
        else if (result === "aborted") this.add("system", "Run aborted.");
        break;
      }

      case "command.rejected":
      case "command.background_failed":
      case "extension.error":
        this.add("error", stringData(event, "error") ?? event.type);
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

  invalidate(): void {}

  render(width: number): string[] {
    if (this.entries.length === 0) {
      return [paint.muted("  Start a conversation below.")];
    }

    const contentWidth = Math.max(1, width - 2);
    const lines: string[] = [];
    for (const entry of this.entries) {
      lines.push(truncateToWidth(`  ${label(entry.kind, entry.complete)}`, width));
      const text = entry.text.length > 0 ? entry.text : "…";
      for (const line of wrapTextWithAnsi(text, contentWidth)) {
        lines.push(truncateToWidth(`  ${line}`, width));
      }
      lines.push("");
    }
    return lines;
  }

  /** Plain projection used by deterministic tests and future non-TTY clients. */
  snapshot(): ReadonlyArray<{ kind: EntryKind; text: string; complete: boolean }> {
    return this.entries.map((entry) => ({ ...entry }));
  }

  private add(kind: EntryKind, text: string, complete = true): ConversationEntry {
    const entry: ConversationEntry = {
      kind,
      text: safeTerminalText(text),
      complete,
    };
    this.entries.push(entry);
    while (this.entries.length > MAX_ENTRIES) {
      const removed = this.entries.shift();
      if (removed === this.currentAssistant) this.currentAssistant = undefined;
      for (const [key, value] of this.tools) {
        if (value === removed) this.tools.delete(key);
      }
    }
    return entry;
  }
}

export class DockStatusLine implements Component {
  private snapshotValue: InstanceSnapshot;
  private activity = "ready";

  constructor(snapshot: InstanceSnapshot) {
    this.snapshotValue = snapshot;
  }

  update(snapshot: InstanceSnapshot): void {
    this.snapshotValue = snapshot;
  }

  setActivity(activity: string): void {
    this.activity = safeTerminalText(activity);
  }

  invalidate(): void {}

  render(width: number): string[] {
    const snapshot = this.snapshotValue;
    const model = snapshot.executor.model
      ? `${snapshot.executor.model.provider}/${snapshot.executor.model.id}`
      : "no model";
    const name = snapshot.name || shortId(snapshot.id);
    const state = snapshot.lifecycle === "active" ? snapshot.execution : snapshot.lifecycle;
    const thinking = snapshot.executor.thinkingLevel ? ` · think ${snapshot.executor.thinkingLevel}` : "";
    const pending = snapshot.pending.total > 0 ? ` · queued ${snapshot.pending.total}` : "";
    return [truncateToWidth(
      paint.muted(`─ ${name} · ${model}${thinking} · ${state}${pending} · ${this.activity} ─`),
      width,
    )];
  }
}

function label(kind: EntryKind, complete: boolean): string {
  switch (kind) {
    case "user": return paint.user("You");
    case "assistant": return paint.assistant(complete ? "Assistant" : "Assistant · streaming");
    case "tool": return paint.muted("Tool");
    case "error": return paint.error("Error");
    case "system": return paint.muted("Dock");
  }
}

function stringData(event: DockEvent, key: string): string | undefined {
  const value = event.data[key];
  return typeof value === "string" ? safeTerminalText(value) : undefined;
}

function numberData(event: DockEvent, key: string): number | undefined {
  const value = event.data[key];
  return typeof value === "number" ? value : undefined;
}

function safeTerminalText(text: string): string {
  return text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "");
}

function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}

function shortId(id: string): string {
  return id.slice(0, 8);
}
