import {
  Box,
  Markdown,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
} from "@earendil-works/pi-tui";

import { TOOL_OUTPUT_TRUNCATION_MARKER, isProjectedDisplayEditDiff } from "../core/edit-diff-projection.js";
import {
  isToolPresentationNoticeLine,
  toolPresentationNoticeText,
  type BuiltInToolPresentation,
  type ToolResultNotice,
} from "../core/tool-result-presentation.js";
import type { DockEvent, HistoryEntryDto, InstanceSnapshot, JsonObject, JsonValue } from "../core/managed-instance.js";
import { renderWorkAlu } from "./alu-mascot.js";
import { knownCompactionFeedback } from "./compaction-feedback.js";
import type { RunActivityState } from "./run-activity.js";
import { markdownTheme, paint } from "./theme.js";

type EntryKind = "user" | "assistant" | "thinking" | "tool" | "system" | "status" | "warning" | "error";
type ToolState = "running" | "done" | "failed";

interface ConversationEntry {
  key: string;
  kind: EntryKind;
  text: string;
  complete: boolean;
  diffText?: string;
  toolCallId?: string;
  toolName?: string;
  toolState?: ToolState;
  toolSummary?: string;
  toolErrorSummary?: string;
  toolArgs?: string;
  toolOutput?: string;
  toolPresentation?: BuiltInToolPresentation;
  toolOmitted?: string[];
  toolRenderFloor?: { width: number; expanded: boolean; rows: number };
  summaryKind?: "compaction" | "branch";
  renderRevision: number;
  renderCache?: { width: number; revision: number; expanded: boolean; lines: string[] };
}

interface ConversationRenderCache {
  width: number;
  revision: number;
  lines: string[];
}

interface ToolProjection {
  entry: ConversationEntry;
  id: string;
  name: string;
  args?: string;
  summary?: string;
  output?: string;
  presentation?: BuiltInToolPresentation;
  omitted: string[];
}

const MAX_TOOL_OUTPUT = 8_000;
const MAX_TOOL_ARGS = 4_000;
const MAX_TOOL_SUMMARY = 512;

/** Event-to-chat projection shared by replay, live TUI updates, and deterministic tests. */
export class DockConversation implements Component {
  private readonly entries: ConversationEntry[] = [];
  private readonly tools = new Map<string, ToolProjection>();
  private currentAssistant: ConversationEntry | undefined;
  private currentThinking: ConversationEntry | undefined;
  private lastExtensionInfo: ConversationEntry | undefined;
  private lastLocalStatus: ConversationEntry | undefined;
  private hideThinking = false;
  private toolsExpanded = false;
  private readonly toolExpansionOverrides = new Map<string, boolean>();
  private readonly compactionExpansionOverrides = new Map<string, boolean>();
  private lastToggledDetailKey: string | undefined;
  private outputPadding = 1;
  private revisionValue = 0;
  private historyDisplayCount = 0;
  private liveEntrySequence = 0;
  private renderCache: ConversationRenderCache | undefined;

  reset(): void {
    this.entries.length = 0;
    this.tools.clear();
    this.currentAssistant = undefined;
    this.currentThinking = undefined;
    this.lastExtensionInfo = undefined;
    this.lastLocalStatus = undefined;
    this.historyDisplayCount = 0;
    this.liveEntrySequence = 0;
    this.toolExpansionOverrides.clear();
    this.compactionExpansionOverrides.clear();
    this.lastToggledDetailKey = undefined;
    this.markLayoutChanged();
  }

  applyHistory(entries: HistoryEntryDto[], _truncated: boolean): void {
    const liveEntries = this.entries.slice(this.historyDisplayCount);
    const historyEntries = this.projectHistory(entries);
    this.entries.splice(0, this.entries.length, ...historyEntries, ...liveEntries);
    this.historyDisplayCount = historyEntries.length;
    for (const toolCallId of this.toolExpansionOverrides.keys()) {
      if (!this.entries.some((entry) => entry.toolCallId === toolCallId)) this.toolExpansionOverrides.delete(toolCallId);
    }
    for (const entryKey of this.compactionExpansionOverrides.keys()) {
      if (!this.entries.some((entry) => entry.key === entryKey)) this.compactionExpansionOverrides.delete(entryKey);
    }
    if (this.lastToggledDetailKey && !this.entries.some((entry) => entry.key === this.lastToggledDetailKey)) {
      this.lastToggledDetailKey = undefined;
    }
    const retainedEntries = new Set(this.entries);
    if (this.lastExtensionInfo && !retainedEntries.has(this.lastExtensionInfo)) this.lastExtensionInfo = undefined;
    if (this.lastLocalStatus && !retainedEntries.has(this.lastLocalStatus)) this.lastLocalStatus = undefined;
    this.markLayoutChanged();
  }

  applyReplay(events: DockEvent[], _truncated: boolean): void {
    // Cursor-bound replay is a live delta and must preserve exact event order.
    for (const event of events) this.apply(event);
  }

  applyBootstrapReplay(events: DockEvent[]): void {
    // Fresh attach already has branch-scoped persisted history. Only unresolved
    // message/tool frames from the current Host-owned run may extend it; control
    // and lifecycle events are state recovery, never durable conversation.
    for (const event of events) {
      if (event.type === "message.submitted"
        || event.type === "message.delta"
        || event.type === "message.completed"
        || event.type === "tool.started"
        || event.type === "tool.args_updated"
        || event.type === "tool.output_updated"
        || event.type === "tool.completed") this.apply(event);
    }
  }

  apply(event: DockEvent): void {
    switch (event.type) {
      case "message.submitted": {
        const text = userMessageText(event.data.text, event.data.images ?? []);
        if (text.length > 0) this.add("user", text);
        break;
      }

      case "message.delta": {
        const delta = event.data.delta;
        if (!delta) break;
        if (event.data.block === "thinking") {
          if (this.hideThinking) break;
          this.currentThinking ??= this.add("thinking", "", false);
          this.currentThinking.text += safeTerminalText(delta);
          this.touchEntry(this.currentThinking);
        } else {
          this.currentAssistant ??= this.add("assistant", "", false);
          this.currentAssistant.text += safeTerminalText(delta);
          this.touchEntry(this.currentAssistant);
        }
        this.markOutputChanged();
        break;
      }

      case "message.completed": {
        const role = stringData(event, "role");
        if (role !== "assistant") break;
        const text = contentText(event.data.content, "text");
        const thinking = contentText(event.data.content, "thinking");
        let changed = false;
        if (!this.hideThinking && (this.currentThinking || thinking)) {
          const completed = thinking === undefined ? undefined : safeTerminalText(thinking);
          const entry = this.currentThinking ?? this.add("thinking", completed ?? "", false);
          if (completed !== undefined && completed.length >= entry.text.length) entry.text = completed;
          entry.complete = true;
          this.touchEntry(entry);
          changed = true;
        }
        this.currentThinking = undefined;

        // Failed transport attempts can complete without assistant text. Retry
        // events own intermediate noise and run.settled owns the final error.
        const completed = text === undefined ? undefined : safeTerminalText(text);
        const entry = this.currentAssistant ?? (completed ? this.add("assistant", completed, false) : undefined);
        if (entry) {
          if (completed !== undefined && completed.length >= entry.text.length) entry.text = completed;
          entry.complete = true;
          this.touchEntry(entry);
          changed = true;
        }
        this.currentAssistant = undefined;
        if (changed) this.markOutputChanged();
        break;
      }

      case "tool.started": {
        const name = stringData(event, "toolName") ?? "tool";
        const callId = stringData(event, "toolCallId") ?? `${event.sequence}`;
        const projected: ToolProjection = this.tools.get(callId) ?? {
          entry: this.addTool(callId, false),
          id: callId,
          name,
          omitted: [],
        };
        projected.name = name;
        projected.args = formatToolArgs(name, event.data.args, MAX_TOOL_ARGS);
        projected.summary = summarizeToolArgs(name, event.data.args);
        projected.omitted = [...new Set([...projected.omitted, ...(event.data.omittedFields ?? [])])];
        projected.presentation = undefined;
        projected.entry.complete = false;
        projected.entry.diffText = undefined;
        this.tools.set(callId, projected);
        this.updateTool(projected, "running");
        break;
      }

      case "tool.args_updated": {
        const callId = stringData(event, "toolCallId") ?? `${event.sequence}`;
        const tool = this.tools.get(callId);
        if (!tool) break;
        const args = formatToolArgs(tool.name, event.data.args, MAX_TOOL_ARGS);
        const summary = summarizeToolArgs(tool.name, event.data.args);
        const omitted = [...(event.data.omittedFields ?? [])];
        if (tool.args === args && tool.summary === summary && stringArraysEqual(tool.omitted, omitted)) break;
        tool.args = args;
        tool.summary = summary;
        tool.omitted = omitted;
        this.updateTool(tool, "running");
        break;
      }

      case "tool.output_updated": {
        const callId = stringData(event, "toolCallId") ?? `${event.sequence}`;
        const tool = this.tools.get(callId);
        if (!tool) break;
        const output = truncate(stringData(event, "text") ?? "", MAX_TOOL_OUTPUT);
        const presentation = event.data.presentation?.kind === toolBaseName(tool.name) ? event.data.presentation : undefined;
        if (tool.output === output && tool.presentation === presentation) break;
        tool.output = output;
        tool.presentation = presentation;
        this.updateTool(tool, "running");
        break;
      }

      case "tool.completed": {
        const name = stringData(event, "toolName") ?? "tool";
        const callId = stringData(event, "toolCallId") ?? `${event.sequence}`;
        const tool: ToolProjection = this.tools.get(callId) ?? {
          entry: this.addTool(callId, false),
          id: callId,
          name,
          omitted: [],
        };
        tool.name = name;
        tool.output = truncate(stringData(event, "text") ?? "", MAX_TOOL_OUTPUT);
        tool.presentation = event.data.presentation?.kind === toolBaseName(name) ? event.data.presentation : undefined;
        tool.omitted = [...new Set([...tool.omitted, ...(event.data.omittedFields ?? [])])];
        const isError = event.data.isError === true;
        tool.entry.complete = true;
        this.updateTool(tool, isError ? "failed" : "done");
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
        this.add("system", `Retrying (${numberData(event, "attempt") ?? "?"}/${numberData(event, "maxAttempts") ?? "?"}) in ${numberData(event, "delayMs") ?? 0}ms…`);
        break;

      case "run.retry_completed":
        this.add(event.data.success ? "system" : "error", event.data.success ? `Retry ${event.data.attempt} resumed.` : event.data.error ?? "Retry failed.");
        break;

      case "compaction.started":
        // In-progress compaction belongs exclusively to fixed activity.
        break;

      case "compaction.completed":
        // Definitive no-op/cancel outcomes belong to the replaceable activity
        // surface, not the durable session conversation.
        if (event.data.aborted || knownCompactionFeedback(event.data.error)) break;
        this.add(event.data.error ? "error" : "system", event.data.error ?? `Compaction completed${event.data.willRetry ? " · retrying" : ""}.`);
        break;

      case "run.settled": {
        const result = stringData(event, "result");
        if (this.currentAssistant) this.currentAssistant.complete = true;
        if (this.currentThinking) this.currentThinking.complete = true;
        this.currentAssistant = undefined;
        this.currentThinking = undefined;
        for (const tool of this.tools.values()) {
          tool.entry.complete = true;
          const interruption = result === "succeeded" ? undefined : `interrupted by ${result ?? "settlement"}`;
          if (interruption) tool.output = [tool.output, interruption].filter(Boolean).join("\n");
          this.updateTool(tool, result === "succeeded" ? "done" : "failed");
          if (interruption) tool.entry.toolErrorSummary = interruption;
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
          const interruption = "interrupted by session replacement";
          tool.output = [tool.output, interruption].filter(Boolean).join("\n");
          this.updateTool(tool, "failed");
          tool.entry.toolErrorSummary = interruption;
        }
        this.add("system", `Session ${event.data.reason} · generation ${event.data.runtimeGeneration}.`);
        this.currentAssistant = undefined;
        this.currentThinking = undefined;
        this.tools.clear();
        break;

      case "session.navigated":
        this.add("system", `Session branch selected${event.data.summaryCreated ? " with summary" : ""} · ${event.data.targetId}.`);
        break;

      case "command.handled":
        // Completion remains visible through RunActivity; it is not conversation content.
        break;

      case "command.rejected":
      case "instance.error":
      case "instance.runtime_error":
      case "extension.error":
      case "settings.write_failed":
        this.add("error", stringData(event, "error") ?? event.type);
        break;

      case "extension.notification":
        this.addExtensionNotification(event.data.level, event.data.message);
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

  /** Pi-style chat-tail status: consecutive local feedback replaces in place. */
  addStatus(text: string): void {
    const message = safeTerminalText(text);
    const previous = this.lastLocalStatus;
    if (previous && this.entries.at(-1) === previous) {
      previous.text = message;
      this.touchEntry(previous);
      this.markOutputChanged();
      return;
    }
    this.lastLocalStatus = this.add("status", message);
  }

  setHideThinking(hidden: boolean): void {
    if (hidden === this.hideThinking) return;
    this.hideThinking = hidden;
    if (hidden && this.currentThinking) {
      this.currentThinking.complete = true;
      this.currentThinking = undefined;
    }
    this.markLayoutChanged();
  }
  setOutputPadding(padding: number): void {
    const next = Math.max(0, Math.min(3, Math.floor(padding)));
    if (next !== this.outputPadding) {
      this.outputPadding = next;
      for (const entry of this.entries) entry.renderCache = undefined;
      this.markLayoutChanged();
    }
  }
  setToolsExpanded(expanded: boolean): void {
    this.toolsExpanded = expanded;
    this.toolExpansionOverrides.clear();
    for (const entry of this.entries) {
      if (entry.toolCallId) entry.toolRenderFloor = undefined;
    }
    this.markLayoutChanged();
  }
  toggleToolsExpanded(): boolean {
    this.setToolsExpanded(!this.toolsExpanded);
    return this.toolsExpanded;
  }
  toggleLatestToolExpanded(): { expanded: boolean; name: string } | undefined {
    const entry = [...this.entries].reverse().find((candidate) => candidate.toolCallId !== undefined);
    if (!entry?.toolCallId) return undefined;
    const expanded = !this.isToolExpanded(entry);
    this.toolExpansionOverrides.set(entry.toolCallId, expanded);
    entry.toolRenderFloor = undefined;
    this.markLayoutChanged();
    return { expanded, name: entry.toolName ?? "tool" };
  }
  toggleLatestDetailExpanded(): { expanded: boolean; name: string } | undefined {
    const reversed = [...this.entries].reverse();
    // Compaction is otherwise unreachable once a later tool appears because
    // Work deliberately has no transcript-row focus cursor.
    const entry = reversed.find((candidate) => candidate.summaryKind === "compaction")
      ?? reversed.find((candidate) => candidate.toolCallId !== undefined);
    if (!entry) return undefined;
    this.lastToggledDetailKey = entry.key;
    if (entry.toolCallId) {
      const expanded = !this.isToolExpanded(entry);
      this.toolExpansionOverrides.set(entry.toolCallId, expanded);
      entry.toolRenderFloor = undefined;
      this.markLayoutChanged();
      return { expanded, name: entry.toolName ?? "tool" };
    }
    const expanded = !this.isCompactionExpanded(entry);
    this.compactionExpansionOverrides.set(entry.key, expanded);
    this.markLayoutChanged();
    return { expanded, name: "compaction" };
  }
  areToolsExpanded(): boolean { return this.toolsExpanded; }
  invalidate(): void {
    this.renderCache = undefined;
    for (const entry of this.entries) entry.renderCache = undefined;
  }

  render(width: number): string[] {
    if (this.renderCache?.width === width && this.renderCache.revision === this.revisionValue) {
      return this.renderCache.lines;
    }
    if (this.entries.length === 0) {
      const lines = [paint.muted("  Start a conversation below.")];
      this.renderCache = { width, revision: this.revisionValue, lines };
      return lines;
    }

    const indent = " ".repeat(this.outputPadding);
    const contentWidth = Math.max(1, width - visibleIndentWidth(indent));
    const lines: string[] = [];
    for (const entry of this.entries) {
      if (this.hideThinking && entry.kind === "thinking") continue;
      const fullWidthSurface = entry.kind === "user" || entry.toolCallId !== undefined || entry.summaryKind === "compaction";
      const entryWidth = fullWidthSurface ? width : contentWidth;
      const entryIndent = fullWidthSurface ? "" : indent;
      const rendered = this.renderEntry(entry, entryWidth);
      if (rendered.length === 0) continue;
      for (const line of rendered) {
        // Every entry renderer is width-bounded. Avoid rescanning all cached
        // history rows on each live delta merely to truncate them a second time.
        lines.push(`${entryIndent}${line}`);
      }
      lines.push("");
    }
    const visible = lines.length > 0 ? lines : [paint.muted("  Start a conversation below.")];
    this.renderCache = { width, revision: this.revisionValue, lines: visible };
    return visible;
  }

  /** Plain projection used by deterministic tests and non-TTY validation. */
  snapshot(): ReadonlyArray<{ kind: EntryKind; text: string; complete: boolean }> {
    return this.entries.map(({ kind, text, complete }) => ({ kind, text, complete }));
  }

  private entryExpanded(entry: ConversationEntry): boolean {
    return entry.toolCallId !== undefined
      ? this.isToolExpanded(entry)
      : entry.summaryKind === "compaction"
        ? this.isCompactionExpanded(entry)
        : true;
  }

  private renderEntry(entry: ConversationEntry, width: number): string[] {
    const expanded = this.entryExpanded(entry);
    const cached = entry.renderCache;
    if (cached?.width === width && cached.revision === entry.renderRevision && cached.expanded === expanded) return cached.lines;

    let lines: string[];
    if (entry.toolCallId) {
      const content: string[] = [renderToolHeader(entry, width)];
      if (expanded) {
        if (entry.toolArgs && !entry.diffText) content.push(paint.faint("args"), ...renderToolDetails(entry.toolArgs, width));
        if (entry.toolOmitted && entry.toolOmitted.length > 0) {
          content.push(paint.warning(`omitted: ${entry.toolOmitted.join(", ")}`));
        }
        if (entry.diffText) {
          content.push(paint.faint(entry.toolState === "running" ? "changes" : "result"));
          const diff = removeProjectedNoticeLines(entry.diffText, entry.toolPresentation);
          content.push(...renderDockDiff(diff).flatMap((line) => renderToolDetailLine(line, width)));
          content.push(...renderToolPresentationNotices(entry.toolPresentation, width));
        } else if (entry.toolOutput || (entry.toolPresentation?.notices.length ?? 0) > 0) {
          content.push(paint.faint("result"));
          const output = removeProjectedNoticeLines(entry.toolOutput ?? "", entry.toolPresentation);
          if (output.length > 0) content.push(...renderToolDetails(output, width));
          content.push(...renderToolPresentationNotices(entry.toolPresentation, width));
        }
      } else {
        content.push(...renderToolPreview(entry, width));
      }
      const floor = entry.toolRenderFloor;
      const naturalRows = content.length;
      const floorRows = floor?.width === width && floor.expanded === expanded
        ? Math.max(floor.rows, naturalRows)
        : naturalRows;
      entry.toolRenderFloor = { width, expanded, rows: floorRows };
      while (content.length < floorRows) content.push("");
      lines = renderToolSurface(content, width, entry.toolState);
    } else if (entry.summaryKind === "compaction") {
      lines = renderCompactionSummary(entry.text, width, expanded);
    } else if (entry.kind === "user") {
      lines = entry.text.length > 0 ? renderUserSurface(entry.text, width, this.outputPadding) : [];
    } else if (entry.kind === "assistant" || entry.kind === "thinking") {
      if (entry.text.length === 0) {
        lines = [];
      } else {
        const innerWidth = entry.kind === "thinking" ? Math.max(1, width - 2) : width;
        const markdown = new Markdown(
          entry.text,
          0,
          0,
          markdownTheme,
          entry.kind === "thinking" ? { color: paint.thinking, italic: true } : undefined,
        );
        const content = markdown.render(innerWidth);
        lines = entry.kind === "thinking"
          ? content.map((line) => `  ${paint.thinking(line)}`)
          : content;
      }
    } else if (entry.kind === "error") {
      lines = renderNotice(entry.text.length > 0 ? entry.text : "Unknown error", width, "error");
    } else if (entry.kind === "warning") {
      lines = renderNotice(entry.text.length > 0 ? entry.text : "Warning", width, "warning");
    } else {
      lines = entry.text.length > 0 ? renderNotice(entry.text, width, "info") : [];
    }

    entry.renderCache = { width, revision: entry.renderRevision, expanded, lines };
    return lines;
  }

  private projectHistory(entries: readonly HistoryEntryDto[]): ConversationEntry[] {
    const projectedEntries: ConversationEntry[] = [];
    const projectedTools = new Map<string, ToolProjection>();
    const pieceCounts = new Map<string, number>();
    const addProjected = (
      source: HistoryEntryDto,
      kind: EntryKind,
      text: string,
      complete = true,
    ): ConversationEntry => {
      const piece = pieceCounts.get(source.recordId) ?? 0;
      pieceCounts.set(source.recordId, piece + 1);
      const entry = this.createEntry(`history:${source.recordId}:${piece}`, kind, text, complete);
      projectedEntries.push(entry);
      return entry;
    };

    for (const source of entries) {
      if (source.visibility === "hidden") continue;
      const text = contentText(source.content, "text");
      if (source.visibility === "metadata") {
        const metadataText = source.kind === "model_change"
          ? `Model changed to ${source.provider ?? "unknown"}/${source.modelId ?? "unknown"}`
          : source.kind === "thinking_level_change"
            ? `Thinking level changed to ${source.thinkingLevel ?? "unknown"}`
            : source.kind === "session_info" && source.name
              ? `Session named ${source.name}`
              : undefined;
        if (metadataText) addProjected(source, "system", metadataText);
        continue;
      }
      if (source.kind === "message" && source.source === "user") {
        const projected = userMessageText(text ?? "", source.content.filter((block) => block.type === "image"));
        if (projected.length > 0) addProjected(source, "user", projected);
      } else if (source.kind === "message" && source.source === "assistant") {
        for (const block of source.content) {
          if (block.type === "thinking") {
            if (block.text.length > 0) addProjected(source, "thinking", block.text);
            continue;
          }
          if (block.type === "text") {
            if (block.text.length > 0) addProjected(source, "assistant", block.text);
            continue;
          }
          if (block.type !== "tool_call") continue;
          const toolEntry = addProjected(source, "tool", "");
          toolEntry.toolCallId = block.toolCallId;
          const tool: ToolProjection = {
            entry: toolEntry,
            id: block.toolCallId,
            name: block.toolName,
            args: formatToolArgs(block.toolName, block.args, MAX_TOOL_ARGS),
            summary: summarizeToolArgs(block.toolName, block.args),
            omitted: [...(block.omittedFields ?? [])],
          };
          projectedTools.set(block.toolCallId, tool);
          projectToolState(tool, "done");
        }
        if (source.error) addProjected(source, "error", source.error);
      } else if (source.kind === "message" && source.source === "tool") {
        for (const block of source.content) {
          if (block.type !== "tool_result") continue;
          const tool: ToolProjection = projectedTools.get(block.toolCallId) ?? (() => {
            const toolEntry = addProjected(source, "tool", "");
            toolEntry.toolCallId = block.toolCallId;
            return {
              entry: toolEntry,
              id: block.toolCallId,
              name: block.toolName,
              omitted: [],
            };
          })();
          tool.name = block.toolName;
          tool.output = truncate(safeTerminalText(block.text), MAX_TOOL_OUTPUT);
          tool.presentation = block.presentation?.kind === toolBaseName(block.toolName) ? block.presentation : undefined;
          tool.omitted = [...new Set([...tool.omitted, ...(block.omittedFields ?? [])])];
          projectToolState(tool, block.isError ? "failed" : "done");
          projectedTools.delete(block.toolCallId);
        }
      } else {
        const projected = text ?? source.error;
        if (projected !== undefined && projected.length > 0) {
          const entry = addProjected(source, source.error ? "error" : "system", projected);
          entry.summaryKind = source.kind === "compaction_summary" ? "compaction"
            : source.kind === "branch_summary" ? "branch"
              : undefined;
        }
      }
    }
    return projectedEntries;
  }

  private updateTool(tool: ToolProjection, state: ToolState): void {
    const parts = [`${tool.name} ${state}`];
    if (tool.args) parts.push(`args\n${tool.args}`);
    if (tool.omitted.length > 0) parts.push(`omitted: ${tool.omitted.join(", ")}`);
    if (tool.output) parts.push(`result\n${tool.output}`);
    const text = safeTerminalText(parts.join("\n"));
    if (
      tool.entry.text === text
      && tool.entry.toolName === tool.name
      && tool.entry.toolState === state
      && tool.entry.toolSummary === tool.summary
      && tool.entry.toolErrorSummary === (state === "failed" ? summarizeToolFailure(tool.output) : undefined)
      && toolPresentationsEqual(tool.entry.toolPresentation, tool.presentation)
    ) return;
    tool.entry.text = text;
    tool.entry.toolName = tool.name;
    tool.entry.toolState = state;
    tool.entry.toolSummary = tool.summary;
    tool.entry.toolErrorSummary = state === "failed" ? summarizeToolFailure(tool.output) : undefined;
    tool.entry.toolArgs = tool.args === undefined ? undefined : safeTerminalText(tool.args);
    tool.entry.toolOutput = tool.output === undefined ? undefined : truncate(safeTerminalText(tool.output), MAX_TOOL_OUTPUT);
    tool.entry.toolPresentation = tool.presentation;
    tool.entry.toolOmitted = tool.omitted.map(safeTerminalLine);
    tool.entry.diffText = state !== "failed"
      ? tool.presentation?.displayDiff ?? (looksLikeToolDiff(tool.name, tool.output) ? tool.output : undefined)
      : undefined;
    this.touchEntry(tool.entry);
    this.markOutputChanged();
  }

  private addTool(toolCallId: string, complete: boolean): ConversationEntry {
    const entry = this.add("tool", "", complete);
    entry.toolCallId = toolCallId;
    return entry;
  }

  private addExtensionNotification(level: "info" | "warning" | "error", message: string): void {
    if (level === "info") {
      const previous = this.lastExtensionInfo;
      if (previous && this.entries.at(-1) === previous) {
        previous.text = safeTerminalText(message);
        this.touchEntry(previous);
        this.markOutputChanged();
        return;
      }
      this.lastExtensionInfo = this.add("status", message);
      return;
    }
    this.add(level === "warning" ? "warning" : "error", message);
  }

  private isToolExpanded(entry: ConversationEntry): boolean {
    if (!entry.toolCallId) return true;
    return this.toolExpansionOverrides.get(entry.toolCallId) ?? this.toolsExpanded;
  }

  private isCompactionExpanded(entry: ConversationEntry): boolean {
    return this.compactionExpansionOverrides.get(entry.key) ?? false;
  }

  private add(kind: EntryKind, text: string, complete = true): ConversationEntry {
    const entry = this.createEntry(`live:${++this.liveEntrySequence}`, kind, text, complete);
    this.entries.push(entry);
    this.markOutputChanged();
    return entry;
  }

  private createEntry(
    key: string,
    kind: EntryKind,
    text: string,
    complete = true,
  ): ConversationEntry {
    return { key, kind, text: safeTerminalText(text), complete, renderRevision: 0 };
  }

  private touchEntry(entry: ConversationEntry): void {
    entry.renderRevision += 1;
    entry.renderCache = undefined;
  }

  private markLayoutChanged(): void { this.revisionValue += 1; }
  private markOutputChanged(): void { this.revisionValue += 1; }
}

function projectToolState(tool: ToolProjection, state: ToolState): void {
  const parts = [`${tool.name} ${state}`];
  if (tool.args) parts.push(`args\n${tool.args}`);
  if (tool.omitted.length > 0) parts.push(`omitted: ${tool.omitted.join(", ")}`);
  if (tool.output) parts.push(`result\n${tool.output}`);
  tool.entry.text = safeTerminalText(parts.join("\n"));
  tool.entry.toolName = tool.name;
  tool.entry.toolState = state;
  tool.entry.toolSummary = tool.summary;
  tool.entry.toolErrorSummary = state === "failed" ? summarizeToolFailure(tool.output) : undefined;
  tool.entry.toolArgs = tool.args === undefined ? undefined : safeTerminalText(tool.args);
  tool.entry.toolOutput = tool.output === undefined ? undefined : truncate(safeTerminalText(tool.output), MAX_TOOL_OUTPUT);
  tool.entry.toolPresentation = tool.presentation;
  tool.entry.toolOmitted = tool.omitted.map(safeTerminalLine);
  tool.entry.diffText = state !== "failed"
    ? tool.presentation?.displayDiff ?? (looksLikeToolDiff(tool.name, tool.output) ? tool.output : undefined)
    : undefined;
  tool.entry.renderRevision += 1;
  tool.entry.renderCache = undefined;
}

export class DockActivityLine implements Component {
  private label = "ready";
  private phase: RunActivityState["phase"] = "idle";
  private animationFrame = 0;
  private animationListener: (() => void) | undefined;

  setAnimationListener(listener: (() => void) | undefined): void {
    this.animationListener = listener;
    listener?.();
  }

  setActivity(activity: RunActivityState): void {
    const label = safeTerminalLine(activity.label);
    if (activity.phase !== this.phase) this.animationFrame = 0;
    this.label = label;
    this.phase = activity.phase;
    this.animationListener?.();
  }

  isAnimated(): boolean { return isAnimatedActivityPhase(this.phase); }

  advanceAnimationFrame(): boolean {
    if (!this.isAnimated()) return false;
    this.animationFrame = (this.animationFrame + 1) % ACTIVITY_FRAMES.length;
    return true;
  }

  render(width: number): string[] {
    const compact = width <= 43;
    const symbol = activitySymbolFor(this.phase, this.animationFrame);
    const alu = renderWorkAlu(this.phase, this.animationFrame, undefined, compact);
    const line = activityPainter(this.phase)(compact ? this.label : `${symbol} ${this.label}`);
    return [truncateToWidth(` ${alu} ${line}`, Math.max(1, width))];
  }

  invalidate(): void {}
}

export class DockWorkMetadata implements Component {
  constructor(private readonly snapshot: () => InstanceSnapshot) {}
  invalidate(): void {}

  render(width: number): string[] {
    const boundedWidth = Math.max(1, width);
    const snapshot = this.snapshot();
    const sessionName = safeTerminalLine(snapshot.name || "Unnamed session");
    const name = snapshot.key === undefined ? sessionName : `${sessionName} [${safeTerminalLine(snapshot.key)}]`;
    const cwd = safeTerminalLine(snapshot.cwd);
    const branch = snapshot.gitBranch === undefined ? undefined : safeTerminalLine(snapshot.gitBranch);
    const provider = safeTerminalLine(snapshot.executor.model?.provider ?? "");
    const modelId = safeTerminalLine(snapshot.executor.model?.id ?? "no model");
    const model = provider.length > 0 ? `${provider}/${modelId}` : modelId;
    const thinking = safeTerminalLine(snapshot.executor.thinkingLevel ?? "off");
    const right = boundedWidth <= 60
      ? `${paint.primary(modelId)}${paint.faint(" · ")}${paint.thinking(thinking)}`
      : `${paint.primary(model)}${paint.faint(" · ")}${paint.thinking(`think ${thinking}`)}`;
    return [fitOpposedLine(
      boundedWidth,
      paint.bold(paint.primary(name)),
      cwd,
      right,
      branch,
    )];
  }
}

export class DockStatusLine implements Component {
  private snapshotValue: InstanceSnapshot;

  constructor(snapshot: InstanceSnapshot) { this.snapshotValue = snapshot; }
  update(snapshot: InstanceSnapshot): void { this.snapshotValue = snapshot; }
  // Connection loss remains actionable in the activity row; controller and settings
  // state intentionally have no default-chrome representation.
  setConnection(_connection: string): void {}
  setController(_controller: string): void {}
  setAutoCompaction(_enabled: boolean | undefined): void {}
  invalidate(): void {}

  render(width: number): string[] {
    const boundedWidth = Math.max(1, width);
    const snapshot = this.snapshotValue;
    const metrics = fitFooterSegments(boundedWidth, formatMetricSegments(snapshot).map(paint.muted));
    const statuses = Object.entries(snapshot.extensionStatus);
    const extensions = statuses.length === 0
      ? ""
      : fitFooterSegments(boundedWidth, statuses.map(([key, value]) => (
          paint.faint(`${safeTerminalLine(key)}: ${safeTerminalLine(value)}`)
        )));
    // Keep the extension-owned row reserved so activity and editor rows never jump.
    return [metrics, extensions];
  }
}

function renderUserSurface(text: string, width: number, outputPadding: number): string[] {
  const boundedWidth = Math.max(1, width);
  if (boundedWidth <= outputPadding * 2) return wrapPlainText(text, boundedWidth).map(paint.userSurface);
  const box = new Box(outputPadding, 1, paint.userSurface);
  box.addChild(new Markdown(
    text,
    0,
    0,
    markdownTheme,
    { color: paint.primary },
    { preserveOrderedListMarkers: true, preserveBackslashEscapes: true },
  ));
  return box.render(boundedWidth);
}

function renderCompactionSummary(text: string, width: number, expanded: boolean): string[] {
  if (text.length === 0) return [];
  const bodyWidth = Math.max(1, width - 2);
  const lines = [
    paint.bold(paint.warning(expanded ? "[compaction · expanded]" : "[compaction]")),
    "",
  ];
  if (!expanded) {
    lines.push(...wrapPlainText("Earlier conversation was compacted into this summary.", bodyWidth));
    lines.push(...wrapPlainText("Alt+O expands it; messages below are the retained context.", bodyWidth).map(paint.muted));
  } else {
    lines.push(paint.muted("Alt+O collapse"), "");
    const markdown = new Markdown(text, 0, 0, markdownTheme);
    lines.push(...markdown.render(bodyWidth));
  }
  return renderSemanticSurface(lines, width, paint.compactionSurface);
}

function renderToolHeader(entry: ConversationEntry, width: number): string {
  const state = entry.toolState ?? (entry.complete ? "done" : "running");
  const icon = state === "failed" ? "×" : state === "done" ? "✓" : "◆";
  const segments = [toolStatePainter(state)(`${icon} ${entry.toolName ?? "tool"}`)];
  if (entry.toolSummary) segments.push(paint.primary(entry.toolSummary));
  if (entry.toolErrorSummary) segments.push(paint.error(entry.toolErrorSummary));
  return truncateToWidth(segments.join(paint.faint(" · ")), Math.max(1, width - 2));
}

function renderToolDetails(text: string, width: number): string[] {
  if (text.length === 0) return [];
  return text.split("\n").flatMap((sourceLine) => {
    const line = sourceLine || " ";
    return renderToolDetailLine(isToolPresentationNoticeLine(line) ? paint.warning(line) : line, width);
  });
}

function renderToolDetailLine(line: string, width: number): string[] {
  const bodyWidth = Math.max(1, width - 4);
  return wrapTextWithAnsi(expandHorizontalTabs(line), bodyWidth).map((wrapped) => `  ${wrapped}`);
}

function renderToolPreview(entry: ConversationEntry, width: number): string[] {
  const lines: string[] = [];
  if (entry.toolOmitted && entry.toolOmitted.length > 0) {
    lines.push(paint.warning(`omitted: ${entry.toolOmitted.join(", ")}`));
  }
  const output = entry.toolOutput?.trim() ?? "";
  const toolName = toolBaseName(entry.toolName ?? "tool");
  if (!entry.diffText && !entry.toolPresentation && !KNOWN_PREVIEW_TOOLS.has(toolName) && looksLikeStructuredJson(output)) {
    const summary = entry.toolState === "failed"
      ? ["structured error result · Ctrl+O details"]
      : summarizeStructuredToolResult(output) ?? ["structured result truncated or unavailable · Ctrl+O details"];
    lines.push(...summary.map((line) => `  ${paint.muted(line)}`));
    return lines;
  }

  const bodyWidth = Math.max(1, width - 4);
  const source = entry.diffText ?? output;
  const body = removeProjectedNoticeLines(source, entry.toolPresentation);
  if (body.length > 0) {
    const sourceLines = body.split("\n");
    const styledSource = entry.diffText ? renderDockDiff(body) : sourceLines;
    const visualRows: Array<{ text: string; changed: boolean; notice: boolean }> = [];
    for (const [index, line] of styledSource.entries()) {
      const sourceLine = sourceLines[index] ?? "";
      const changed = entry.diffText !== undefined && isChangedDiffLine(sourceLine);
      const notice = isToolPresentationNoticeLine(sourceLine);
      for (const wrapped of wrapTextWithAnsi(expandHorizontalTabs(line || " "), bodyWidth)) {
        visualRows.push({ text: wrapped, changed, notice });
      }
    }
    const budget = toolPreviewBudget(toolName);
    const mode = entry.toolPresentation?.preview ?? (toolName === "bash" ? "tail" : entry.diffText ? "head-tail" : "head");
    const preview = entry.diffText
      ? selectDiffPreviewRows(visualRows, budget)
      : selectToolPreviewRows(visualRows.map((row) => row.text), budget, mode);
    lines.push(...preview.map((line) => `  ${line}`));
  }
  lines.push(...renderToolPresentationNotices(entry.toolPresentation, width));
  return lines;
}

function removeProjectedNoticeLines(text: string, presentation: BuiltInToolPresentation | undefined): string {
  if (text.length === 0 || presentation === undefined || presentation.notices.length === 0) return text;
  const lines = text.split("\n").filter((line) => line.trim() !== TOOL_OUTPUT_TRUNCATION_MARKER);
  while (lines.at(-1)?.trim() === "") lines.pop();
  while (lines.length > 0 && isToolPresentationNoticeLine(lines.at(-1) ?? "")) {
    lines.pop();
    while (lines.at(-1)?.trim() === "") lines.pop();
  }
  return lines.join("\n");
}

function renderToolPresentationNotices(
  presentation: BuiltInToolPresentation | undefined,
  width: number,
): string[] {
  if (presentation === undefined || presentation.notices.length === 0) return [];
  return presentation.notices.flatMap((notice) => renderToolPresentationNotice(notice, width));
}

function renderToolPresentationNotice(notice: ToolResultNotice, width: number): string[] {
  return renderToolDetailLine(paint.warning(`! ${toolPresentationNoticeText(notice)}`), width);
}

const KNOWN_PREVIEW_TOOLS = new Set(["bash", "read", "write", "edit", "grep", "find", "ls"]);

function toolPreviewBudget(toolName: string): number {
  if (toolName === "bash") return 5;
  if (toolName === "read" || toolName === "write") return 10;
  if (toolName === "grep") return 15;
  if (toolName === "find" || toolName === "ls") return 20;
  if (toolName === "edit") return 10;
  return 5;
}

function selectToolPreviewRows(
  rows: readonly string[],
  budget: number,
  mode: "head" | "tail" | "head-tail",
): string[] {
  if (rows.length <= budget) return [...rows];
  const visibleBudget = Math.max(1, budget);
  const hidden = rows.length - visibleBudget;
  const marker = paint.faint(`… ${hidden} ${mode === "tail" ? "earlier" : "more"} visual lines · Ctrl+O details`);
  if (mode === "tail") return [marker, ...rows.slice(-visibleBudget)];
  if (mode === "head-tail") {
    const head = Math.ceil(visibleBudget / 2);
    const tail = Math.floor(visibleBudget / 2);
    return [...rows.slice(0, head), marker, ...(tail > 0 ? rows.slice(-tail) : [])];
  }
  return [...rows.slice(0, visibleBudget), marker];
}

function selectDiffPreviewRows(
  rows: readonly { text: string; changed: boolean; notice: boolean }[],
  budget: number,
): string[] {
  if (rows.length <= budget) return rows.map((row) => row.text);
  const visibleBudget = Math.max(1, budget);
  const noticeIndexes = rows.flatMap((row, index) => row.notice ? [index] : []);
  const changedIndexes = rows.flatMap((row, index) => row.changed && !row.notice ? [index] : []);
  if (changedIndexes.length === 0) {
    return selectToolPreviewRows(rows.map((row) => row.text), visibleBudget, "head-tail");
  }

  const selected = new Set<number>(noticeIndexes.slice(0, visibleBudget));
  const changeBudget = visibleBudget - selected.size;
  if (changedIndexes.length > changeBudget) {
    const head = Math.ceil(changeBudget / 2);
    const tail = Math.floor(changeBudget / 2);
    for (const index of changedIndexes.slice(0, head)) selected.add(index);
    if (tail > 0) for (const index of changedIndexes.slice(-tail)) selected.add(index);
  } else {
    for (const index of changedIndexes) selected.add(index);
    for (let distance = 1; selected.size < visibleBudget && distance < rows.length; distance++) {
      for (const index of changedIndexes) {
        if (selected.size >= visibleBudget) break;
        const before = index - distance;
        if (before >= 0) selected.add(before);
        if (selected.size >= visibleBudget) break;
        const after = index + distance;
        if (after < rows.length) selected.add(after);
      }
    }
  }

  const preview = [...selected].sort((left, right) => left - right).map((index) => rows[index]!.text);
  const hidden = rows.length - preview.length;
  preview.push(paint.faint(`… ${hidden} context visual lines hidden · Ctrl+O details`));
  return preview;
}

function isChangedDiffLine(line: string): boolean {
  return (line.startsWith("+") && !line.startsWith("+++ "))
    || (line.startsWith("-") && !line.startsWith("--- "));
}

function looksLikeStructuredJson(text: string): boolean {
  const first = text.trimStart()[0];
  return first === "{" || first === "[";
}

function summarizeStructuredToolResult(text: string): string[] | undefined {
  if (!looksLikeStructuredJson(text)) return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    if (Array.isArray(parsed)) return [`structured result · ${parsed.length} items · Ctrl+O details`];
    if (parsed === null || typeof parsed !== "object") return ["structured result · Ctrl+O details"];
    const record = parsed as Record<string, unknown>;
    const parts: string[] = [];
    if (record.ok === true) parts.push("ok");
    else if (record.ok === false) parts.push("not ok");
    for (const key of ["action", "status", "state"] as const) {
      const value = scalarArgument(record[key] as JsonValue | undefined);
      if (value) parts.push(normalizeToolSummaryPart(value));
    }
    const cardId = scalarArgument((record.card_id ?? record.cardId) as JsonValue | undefined);
    if (cardId) parts.push(`card #${normalizeToolSummaryPart(cardId)}`);
    for (const key of ["count", "total"] as const) {
      const value = scalarArgument(record[key] as JsonValue | undefined);
      if (value) parts.push(`${key} ${normalizeToolSummaryPart(value)}`);
    }
    if (parts.length === 0) parts.push("structured result");
    return [`${parts.slice(0, 4).join(" · ")} · Ctrl+O details`];
  } catch {
    return undefined;
  }
}

function renderToolSurface(lines: string[], width: number, state: ToolState | undefined): string[] {
  const painter = state === "failed"
    ? paint.toolErrorSurface
    : state === "running" || state === undefined
      ? paint.toolRunningSurface
      : paint.toolSurface;
  return renderSemanticSurface(lines, width, painter);
}

function renderSemanticSurface(
  lines: readonly string[],
  width: number,
  painter: (text: string) => string,
): string[] {
  const boundedWidth = Math.max(1, width);
  if (boundedWidth < 3) return lines.map((line) => painter(truncateToWidth(expandHorizontalTabs(line), boundedWidth)));
  return lines.map((line) => painter(padToVisibleWidth(expandHorizontalTabs(` ${line}`), boundedWidth)));
}

function expandHorizontalTabs(text: string): string {
  if (!text.includes("\t")) return text;
  const parts = text.split("\t");
  let expanded = parts[0] ?? "";
  for (const part of parts.slice(1)) {
    const spaces = 8 - (visibleWidth(expanded) % 8);
    expanded += `${" ".repeat(spaces)}${part}`;
  }
  return expanded;
}

function renderNotice(text: string, width: number, tone: "info" | "warning" | "error"): string[] {
  const painter = tone === "error" ? paint.error : tone === "warning" ? paint.warning : paint.muted;
  if (width < 3) return wrapPlainText(text, width).map(painter);
  const bodyWidth = width - 2;
  return wrapPlainText(text, bodyWidth).map((line, index) => {
    const marker = index === 0 ? (tone === "info" ? "·" : "!") : "│";
    return `${tone === "info" ? paint.faint(marker) : painter(marker)} ${painter(line)}`;
  });
}

function wrapPlainText(text: string, width: number): string[] {
  const boundedWidth = Math.max(1, width);
  return text.split("\n").flatMap((line) => wrapTextWithAnsi(line || " ", boundedWidth));
}

function padToVisibleWidth(text: string, width: number): string {
  const fitted = truncateToWidth(text, Math.max(1, width));
  return `${fitted}${" ".repeat(Math.max(0, width - visibleWidth(fitted)))}`;
}

function toolStatePainter(state: ToolState | undefined): (text: string) => string {
  if (state === "failed") return paint.error;
  if (state === "done") return paint.success;
  return paint.running;
}

function fitOpposedLine(width: number, name: string, cwd: string, right: string, branch?: string): string {
  const boundedWidth = Math.max(1, width);
  if (boundedWidth <= 4) return truncateToWidth(name, boundedWidth);
  const innerWidth = boundedWidth - 2;
  const gap = 3;
  const rightWidth = Math.min(visibleWidth(right), Math.max(10, Math.floor(innerWidth * 0.48)));
  const leftWidth = Math.max(1, innerWidth - gap - rightWidth);
  const separator = paint.faint(" · ");
  const leftContentWidth = Math.max(1, leftWidth - visibleWidth(separator));
  const minimumNameWidth = Math.min(12, Math.max(4, Math.floor(leftContentWidth * 0.4)));
  const workspaceWidth = visibleWidth(cwd) + (branch === undefined ? 0 : visibleWidth(branch) + 3);
  const cwdWidth = Math.min(workspaceWidth, Math.max(1, leftContentWidth - minimumNameWidth));
  const nameWidth = Math.max(1, leftContentWidth - cwdWidth);
  const fittedLeft = `${truncateToWidth(name, nameWidth)}${separator}${fitWorkspaceContext(cwd, branch, cwdWidth)}`;
  const fittedRight = truncateToWidth(right, rightWidth);
  const spacing = Math.max(1, innerWidth - visibleWidth(fittedLeft) - visibleWidth(fittedRight));
  return truncateToWidth(` ${fittedLeft}${" ".repeat(spacing)}${fittedRight}`, boundedWidth);
}

function fitWorkspaceContext(cwd: string, branch: string | undefined, width: number): string {
  const boundedWidth = Math.max(1, width);
  if (branch === undefined) return paint.muted(truncateToWidth(cwd, boundedWidth));
  const suffix = `(${branch})`;
  if (visibleWidth(suffix) >= boundedWidth) return paint.accent(truncateToWidth(suffix, boundedWidth));
  const pathWidth = boundedWidth - visibleWidth(suffix) - 1;
  return `${paint.muted(truncateFromLeft(cwd, pathWidth))}${paint.faint(" ")}${paint.accent(suffix)}`;
}

function truncateFromLeft(text: string, width: number): string {
  const boundedWidth = Math.max(1, width);
  if (visibleWidth(text) <= boundedWidth) return text;
  const characters = [...text];
  let low = 0;
  let high = characters.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (visibleWidth(`…${characters.slice(middle).join("")}`) <= boundedWidth) high = middle;
    else low = middle + 1;
  }
  return `…${characters.slice(low).join("")}`;
}

function fitFooterSegments(width: number, segments: readonly string[]): string {
  if (segments.length === 0) return "";
  let line = `  ${segments[0] ?? ""}`;
  for (const segment of segments.slice(1)) {
    const candidate = `${line}${paint.faint(" · ")}${segment}`;
    if (visibleWidth(candidate) <= width) line = candidate;
  }
  return truncateToWidth(line, width);
}

function formatMetricSegments(snapshot: InstanceSnapshot): string[] {
  const metrics = snapshot.metrics;
  if (!metrics) return ["cache —", "ctx —", "↑— ↓—", "$—"];
  const denominator = metrics.tokens.input + metrics.tokens.cacheRead + metrics.tokens.cacheWrite;
  const cache = denominator > 0 ? `${Math.round((metrics.tokens.cacheRead / denominator) * 100)}%` : "—";
  const context = metrics.context
    ? `${formatCount(metrics.context.tokens)}/${formatCount(metrics.context.contextWindow)}${metrics.context.percent === null ? "" : ` ${Math.round(metrics.context.percent)}%`}`
    : "—";
  return [
    `cache ${cache}`,
    `ctx ${context}`,
    `↑${formatCount(metrics.tokens.input)} ↓${formatCount(metrics.tokens.output)}`,
    `$${metrics.cost.toFixed(4)}`,
  ];
}

const ACTIVITY_FRAMES = ["◐", "◓", "◑", "◒"] as const;

function isAnimatedActivityPhase(phase: RunActivityState["phase"]): boolean {
  return phase === "submitting"
    || phase === "waiting"
    || phase === "thinking"
    || phase === "responding"
    || phase === "retry"
    || phase === "compaction"
    || phase === "aborting";
}

function activitySymbolFor(phase: RunActivityState["phase"], frame: number): string {
  if (isAnimatedActivityPhase(phase)) return ACTIVITY_FRAMES[frame % ACTIVITY_FRAMES.length] ?? ACTIVITY_FRAMES[0];
  if (phase === "idle") return "○";
  if (phase === "interaction") return "?";
  if (phase === "error" || phase === "disconnected") return "×";
  return "●";
}

function activityPainter(phase: RunActivityState["phase"]): (text: string) => string {
  if (phase === "error" || phase === "disconnected") return paint.error;
  if (phase === "interaction") return paint.queue;
  if (phase === "thinking") return paint.thinking;
  if (phase === "idle") return paint.muted;
  return paint.running;
}

function statePainter(state: string): (text: string) => string {
  if (/failed|error|lost|unavailable|stopped/u.test(state)) return paint.error;
  if (state === "running") return paint.running;
  if (state === "idle") return paint.success;
  return paint.muted;
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

function userMessageText(text: string, images: readonly { mimeType: string }[]): string {
  const imageLines = images.map((image, index) => `[Image ${index + 1} · ${image.mimeType}]`);
  if (text.length === 0) return imageLines.join("\n");
  return imageLines.length === 0 ? text : `${text}\n\n${imageLines.join("\n")}`;
}

function toolBaseName(toolName: string): string {
  return toolName.toLowerCase().split(/[.:/]/u).at(-1) ?? toolName.toLowerCase();
}

function summarizeToolArgs(toolName: string, args: JsonObject): string | undefined {
  const name = toolBaseName(toolName);
  const pathArgument = firstStringArgument(args, ["path", "file_path"]);
  const path = pathArgument === undefined ? undefined : pathPreview(pathArgument);

  if (name === "read") {
    return joinToolSummary([path, readRangeSummary(args)]);
  }

  if (name === "bash") {
    return joinToolSummary([commandPreview(firstStringArgument(args, ["command"]))]);
  }

  if (name === "edit") {
    const editCount = Array.isArray(args.edits)
      ? args.edits.length
      : (typeof args.oldText === "string" || typeof args.newText === "string" ? 1 : undefined);
    return joinToolSummary([
      path,
      editCount === undefined ? undefined : `${editCount} ${editCount === 1 ? "edit" : "edits"}`,
    ]);
  }

  if (name === "write") {
    const content = typeof args.content === "string" ? args.content : undefined;
    const lineCount = content === undefined ? undefined : content.length === 0 ? 0 : content.split("\n").length;
    return joinToolSummary([
      path,
      lineCount === undefined ? undefined : `${lineCount} ${lineCount === 1 ? "line" : "lines"}`,
    ]);
  }

  return joinToolSummary(genericToolSummaryParts(args));
}

function readRangeSummary(args: JsonObject): string | undefined {
  const offset = integerArgument(args.offset);
  const limit = integerArgument(args.limit);
  if (offset !== undefined && limit !== undefined && limit > 0) {
    const end = offset <= Number.MAX_SAFE_INTEGER - limit + 1 ? offset + limit - 1 : undefined;
    return end === undefined ? `from line ${offset} · ${limit} lines` : `lines ${offset}–${end}`;
  }
  if (offset !== undefined) return `from line ${offset}`;
  if (limit !== undefined) return `first ${limit} lines`;
  return undefined;
}

function commandPreview(command: string | undefined): string | undefined {
  if (!command) return undefined;
  const lines = safeTerminalText(command)
    .split("\n")
    .map(normalizeToolSummaryPart)
    .filter((line) => line.length > 0);
  const first = lines[0];
  if (!first) return undefined;
  const remaining = lines.length - 1;
  return remaining > 0 ? `${first} ↵ +${remaining} ${remaining === 1 ? "line" : "lines"}` : first;
}

function genericToolSummaryParts(args: JsonObject): Array<string | undefined> {
  const parts: Array<string | undefined> = [];
  const path = firstStringArgument(args, ["path", "file_path", "output_path"]);
  if (path) parts.push(pathPreview(path));
  else {
    const url = firstStringArgument(args, ["url"]);
    if (url) parts.push(url);
  }

  const command = commandPreview(firstStringArgument(args, ["command"]));
  if (command) parts.push(command);
  const action = firstStringArgument(args, ["action"]);
  if (action) parts.push(action);
  const cardId = scalarArgument(args.card_id ?? args.cardId);
  if (cardId) parts.push(`card #${cardId}`);
  const query = firstStringArgument(args, ["query", "pattern"]);
  if (query) parts.push(`${args.query === query ? "query" : "pattern"}: ${query}`);
  const target = firstStringArgument(args, ["target_id", "instanceId", "instance_id"]);
  if (target) parts.push(`target ${target}`);
  const agent = firstStringArgument(args, ["agent", "name"]);
  if (agent) parts.push(agent);

  if (parts.length === 0) {
    for (const [key, singular] of [["urls", "url"], ["file_paths", "file"], ["paths", "path"]] as const) {
      const value = args[key];
      if (Array.isArray(value)) parts.push(`${value.length} ${value.length === 1 ? singular : `${singular}s`}`);
    }
  }
  return parts.slice(0, 3);
}

function pathPreview(value: string): string {
  const normalized = normalizeToolSummaryPart(value);
  const segments = normalized.split(/[\\/]/u).filter((segment) => segment.length > 0);
  return segments.length > 4 ? `…/${segments.slice(-3).join("/")}` : normalized;
}

function firstStringArgument(args: JsonObject, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

function scalarArgument(value: JsonValue | undefined): string | undefined {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  return undefined;
}

function integerArgument(value: JsonValue | undefined): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function joinToolSummary(parts: Array<string | undefined>): string | undefined {
  const normalized = parts
    .map((part) => part === undefined ? "" : normalizeToolSummaryPart(part))
    .filter((part) => part.length > 0);
  if (normalized.length === 0) return undefined;
  return truncateToWidth(normalized.join(" · "), MAX_TOOL_SUMMARY);
}

function normalizeToolSummaryPart(value: string): string {
  return safeTerminalLine(value).replace(/\s+/gu, " ").trim();
}

function summarizeToolFailure(output: string | undefined): string | undefined {
  if (!output) return undefined;
  const trimmed = safeTerminalText(output).trim();
  if (!trimmed) return undefined;
  let candidate: string | undefined;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    candidate = failureTextFromJson(parsed);
  } catch {
    candidate = looksLikeStructuredJson(trimmed) ? "structured error result" : trimmed;
  }
  const candidates = candidate?.split("\n").map((line) => line.trim()).filter((line) => line.length > 0) ?? [];
  const explicitReason = [...candidates].reverse().find((line) => /^(?:command (?:exited|timed out|aborted)|operation aborted|error\b|failed\b|permission denied\b)/iu.test(line));
  const summary = explicitReason ?? candidates.find((line) => !isToolPresentationNoticeLine(line));
  if (!summary) return undefined;
  return truncateToWidth(normalizeToolSummaryPart(summary), MAX_TOOL_SUMMARY);
}

function failureTextFromJson(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  for (const key of ["error", "message", "reason", "stderr"] as const) {
    const candidate = record[key];
    if (typeof candidate === "string" && candidate.trim().length > 0) return candidate;
    if (key === "error" && candidate !== null && typeof candidate === "object" && !Array.isArray(candidate)) {
      const nested = (candidate as Record<string, unknown>).message;
      if (typeof nested === "string" && nested.trim().length > 0) return nested;
    }
  }
  return undefined;
}

function formatToolArgs(toolName: string, args: JsonObject, limit: number): string | undefined {
  const name = toolBaseName(toolName);
  if (name !== "bash" || typeof args.command !== "string") return formatJson(args, limit);

  const command = safeTerminalText(args.command).replace(/\t/gu, "    ");
  const remaining = Object.fromEntries(Object.entries(args).filter(([key]) => key !== "command"));
  const suffix = Object.keys(remaining).length === 0 ? undefined : formatJson(remaining, limit);
  return truncate(["command", ...command.split("\n").map((line) => `  ${line}`), ...(suffix ? ["options", suffix] : [])].join("\n"), limit);
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

function safeTerminalLine(text: string): string {
  return safeTerminalText(text).replace(/[\t\n]/gu, " ");
}

function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}

function toolPresentationsEqual(left: BuiltInToolPresentation | undefined, right: BuiltInToolPresentation | undefined): boolean {
  return left === right || (left !== undefined && right !== undefined && JSON.stringify(left) === JSON.stringify(right));
}

function stringArraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function looksLikeToolDiff(toolName: string, text: string | undefined): text is string {
  if (looksLikeDiff(text)) return true;
  return toolBaseName(toolName) === "edit" && isProjectedDisplayEditDiff(text);
}

function looksLikeDiff(text: string | undefined): boolean {
  if (!text) return false;
  return text.startsWith("diff --git ") || (/^--- .+\n\+\+\+ .+/m.test(text) && /^@@ /m.test(text));
}

function renderDockDiff(text: string): string[] {
  return text.split("\n").map((line) => {
    if (line.startsWith("+++ ") || line.startsWith("--- ") || line.startsWith("diff --git ")) return paint.bold(line);
    if (line.startsWith("@@ ")) return paint.diffHunk(line);
    if (line.startsWith("+")) return paint.diffAdded(line);
    if (line.startsWith("-")) return paint.diffRemoved(line);
    return line;
  });
}

function visibleIndentWidth(indent: string): number { return indent.length; }
function shortId(id: string): string { return id.slice(0, 8); }
