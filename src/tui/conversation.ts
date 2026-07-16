import {
  Markdown,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
} from "@earendil-works/pi-tui";

import type { DockEvent, HistoryEntryDto, InstanceSnapshot } from "../core/managed-instance.js";
import type { HistoryWindowSnapshot } from "./history-pagination.js";
import type { RunActivityState } from "./run-activity.js";
import { markdownTheme, paint } from "./theme.js";

type EntryKind = "user" | "assistant" | "thinking" | "tool" | "system" | "error";
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
  renderRevision: number;
  renderCache?: { width: number; revision: number; expanded: boolean; lines: string[] };
}

export interface ConversationRowAnchor {
  entryKey: string;
  rowWithinEntry: number;
}

interface ConversationRenderCache {
  width: number;
  revision: number;
  lines: string[];
  spanKeys: string[];
  spanStarts: number[];
  spanCounts: number[];
}

interface ToolProjection {
  entry: ConversationEntry;
  id: string;
  name: string;
  args?: string;
  output?: string;
  omitted: string[];
}

const MAX_LIVE_ENTRIES = 200;
const MAX_TOOL_OUTPUT = 8_000;
const MAX_TOOL_ARGS = 4_000;

/** Event-to-chat projection shared by replay, live TUI updates, and deterministic tests. */
export class DockConversation implements Component {
  private readonly entries: ConversationEntry[] = [];
  private readonly tools = new Map<string, ToolProjection>();
  private currentAssistant: ConversationEntry | undefined;
  private currentThinking: ConversationEntry | undefined;
  private hideThinking = false;
  private toolsExpanded = false;
  private readonly toolExpansionOverrides = new Map<string, boolean>();
  private outputPadding = 1;
  private revisionValue = 0;
  private outputRevisionValue = 0;
  private historyDisplayCount = 0;
  private liveEntrySequence = 0;
  private renderCache: ConversationRenderCache | undefined;

  reset(): void {
    this.entries.length = 0;
    this.tools.clear();
    this.currentAssistant = undefined;
    this.currentThinking = undefined;
    this.historyDisplayCount = 0;
    this.liveEntrySequence = 0;
    this.toolExpansionOverrides.clear();
    this.markLayoutChanged();
  }

  applyHistory(entries: HistoryEntryDto[], truncated: boolean): void {
    this.replacePagedHistory({
      entries,
      hasEarlier: truncated,
      hasNewer: false,
      ...(truncated && entries[0] ? { nextBeforeEntryId: entries[0].entryId } : {}),
      loadState: "idle",
      generation: 0,
      revision: 0,
    });
  }

  replacePagedHistory(window: HistoryWindowSnapshot): void {
    const liveEntries = this.entries.slice(this.historyDisplayCount);
    const newerBoundaryIndex = window.newerBoundaryEntryId === undefined
      ? -1
      : window.entries.findIndex((entry) => entry.entryId === window.newerBoundaryEntryId);
    const historyEntries = newerBoundaryIndex > 0
      ? [
          ...this.projectHistory(window.entries.slice(0, newerBoundaryIndex)),
          this.createEntry(
            "history:newer-boundary",
            "system",
            "Newer session history crossed a bounded-memory gap · PageDown continues at the retained live tail.",
          ),
          ...this.projectHistory(window.entries.slice(newerBoundaryIndex)),
        ]
      : this.projectHistory(window.entries);
    if (window.hasEarlier) {
      const text = window.loadState === "loading"
        ? "Loading earlier session history…"
        : window.loadState === "error"
          ? `Earlier session history unavailable: ${window.error ?? "unknown error"}. PageUp retries · Ctrl+End reloads latest.`
          : "Earlier session history is available through paged history.";
      historyEntries.unshift(this.createEntry("history:earlier-boundary", "system", text));
    }
    if (window.hasNewer && newerBoundaryIndex <= 0) {
      historyEntries.push(this.createEntry(
        "history:newer-boundary",
        "system",
        "Newer session history is outside this bounded memory window · Ctrl+End returns to the live tail.",
      ));
    }
    this.entries.splice(0, this.entries.length, ...historyEntries, ...liveEntries);
    this.historyDisplayCount = historyEntries.length;
    for (const toolCallId of this.toolExpansionOverrides.keys()) {
      if (!this.entries.some((entry) => entry.toolCallId === toolCallId)) this.toolExpansionOverrides.delete(toolCallId);
    }
    this.markLayoutChanged();
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
          const entry = this.currentThinking ?? this.add("thinking", "", false);
          if (thinking !== undefined) entry.text = safeTerminalText(thinking);
          entry.complete = true;
          this.touchEntry(entry);
          changed = true;
        }
        this.currentThinking = undefined;

        // Failed transport attempts can complete without assistant text. Retry
        // events own intermediate noise and run.settled owns the final error.
        const entry = this.currentAssistant ?? (text ? this.add("assistant", "", false) : undefined);
        if (entry) {
          if (text !== undefined) entry.text = safeTerminalText(text);
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
        projected.args = formatJson(event.data.args, MAX_TOOL_ARGS);
        projected.omitted = [...new Set([...projected.omitted, ...(event.data.omittedFields ?? [])])];
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
        const args = formatJson(event.data.args, MAX_TOOL_ARGS);
        const omitted = [...(event.data.omittedFields ?? [])];
        if (tool.args === args && stringArraysEqual(tool.omitted, omitted)) break;
        tool.args = args;
        tool.omitted = omitted;
        this.updateTool(tool, "running");
        break;
      }

      case "tool.output_updated": {
        const callId = stringData(event, "toolCallId") ?? `${event.sequence}`;
        const tool = this.tools.get(callId);
        if (!tool) break;
        const output = truncate(stringData(event, "text") ?? "", MAX_TOOL_OUTPUT);
        if (tool.output === output) break;
        tool.output = output;
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
        tool.omitted = [...new Set([...tool.omitted, ...(event.data.omittedFields ?? [])])];
        const isError = event.data.isError === true;
        tool.entry.complete = true;
        this.updateTool(tool, isError ? "failed" : "done");
        tool.entry.diffText = !isError && looksLikeDiff(tool.output) ? tool.output : undefined;
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

      case "session.navigated":
        this.add("system", `Session branch selected${event.data.summaryCreated ? " with summary" : ""} · ${event.data.targetId}.`);
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
      this.markLayoutChanged();
    }
  }
  toggleToolsExpanded(): boolean {
    this.toolsExpanded = !this.toolsExpanded;
    this.toolExpansionOverrides.clear();
    this.markLayoutChanged();
    return this.toolsExpanded;
  }
  toggleLatestToolExpanded(): { expanded: boolean; name: string } | undefined {
    const entry = [...this.entries].reverse().find((candidate) => candidate.toolCallId !== undefined);
    if (!entry?.toolCallId) return undefined;
    const expanded = !this.isToolExpanded(entry);
    this.toolExpansionOverrides.set(entry.toolCallId, expanded);
    this.markLayoutChanged();
    return { expanded, name: entry.toolName ?? "tool" };
  }
  areToolsExpanded(): boolean { return this.toolsExpanded; }
  latestToolOffsetFromBottom(width: number): number | undefined {
    const latestIndex = this.entries.findLastIndex((entry) => entry.toolCallId !== undefined);
    if (latestIndex < 0) return undefined;
    const contentWidth = Math.max(1, width - this.outputPadding - 1);
    let rows = 0;
    for (let index = latestIndex + 1; index < this.entries.length; index += 1) {
      const entry = this.entries[index];
      if (!entry || (this.hideThinking && entry.kind === "thinking")) continue;
      rows += this.renderEntry(entry, contentWidth).length + 1;
    }
    return rows;
  }
  get revision(): number { return this.revisionValue; }
  get outputRevision(): number { return this.outputRevisionValue; }

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
      this.renderCache = {
        width,
        revision: this.revisionValue,
        lines,
        spanKeys: ["conversation:empty"],
        spanStarts: [0],
        spanCounts: [1],
      };
      return lines;
    }

    const indent = " ".repeat(this.outputPadding + 1);
    const contentWidth = Math.max(1, width - visibleIndentWidth(indent));
    const lines: string[] = [];
    const spanKeys: string[] = [];
    const spanStarts: number[] = [];
    const spanCounts: number[] = [];
    for (const entry of this.entries) {
      if (this.hideThinking && entry.kind === "thinking") continue;
      const startRow = lines.length;
      for (const line of this.renderEntry(entry, contentWidth)) {
        // Every entry renderer is width-bounded. Avoid rescanning all cached
        // history rows on each live delta merely to truncate them a second time.
        lines.push(`${indent}${line}`);
      }
      lines.push("");
      spanKeys.push(entry.key);
      spanStarts.push(startRow);
      spanCounts.push(lines.length - startRow);
    }
    this.renderCache = {
      width,
      revision: this.revisionValue,
      lines,
      spanKeys,
      spanStarts,
      spanCounts,
    };
    return lines;
  }

  rowAnchor(width: number, rowIndex: number): ConversationRowAnchor | undefined {
    this.render(width);
    const target = Math.max(0, Math.floor(rowIndex));
    const cache = this.renderCache;
    if (!cache) return undefined;
    for (let index = 0; index < cache.spanKeys.length; index += 1) {
      const startRow = cache.spanStarts[index] ?? 0;
      if (target >= startRow && target < startRow + (cache.spanCounts[index] ?? 0)) {
        return { entryKey: cache.spanKeys[index]!, rowWithinEntry: target - startRow };
      }
    }
    return undefined;
  }

  rowIndexForAnchor(width: number, anchor: ConversationRowAnchor): number | undefined {
    this.render(width);
    const cache = this.renderCache;
    const index = cache?.spanKeys.indexOf(anchor.entryKey) ?? -1;
    if (!cache || index < 0) return undefined;
    const startRow = cache.spanStarts[index] ?? 0;
    const rowCount = cache.spanCounts[index] ?? 1;
    return startRow + Math.min(Math.max(0, anchor.rowWithinEntry), rowCount - 1);
  }

  /** Plain projection used by deterministic tests and non-TTY validation. */
  snapshot(): ReadonlyArray<{ kind: EntryKind; text: string; complete: boolean }> {
    return this.entries.map(({ kind, text, complete }) => ({ kind, text, complete }));
  }

  private renderEntry(entry: ConversationEntry, width: number): string[] {
    const expanded = entry.toolCallId === undefined || this.isToolExpanded(entry);
    const cached = entry.renderCache;
    if (cached?.width === width && cached.revision === entry.renderRevision && cached.expanded === expanded) {
      return cached.lines;
    }

    let lines: string[];
    if (entry.toolCallId) {
      const header = renderToolHeader(entry, width, expanded);
      if (!expanded) {
        lines = [header];
      } else if (entry.diffText) {
        const marker = "\nresult\n";
        const markerIndex = entry.text.indexOf(marker);
        const detailText = markerIndex >= 0 ? entry.text.slice(0, markerIndex) : entry.text.split("\n")[0] ?? "";
        const details = detailText.split("\n").slice(1).join("\n");
        lines = [
          header,
          ...renderToolDetails(details, width, entry.toolState),
          ...renderDockDiff(entry.diffText).map((line) => renderToolDetailLine(line, width, entry.toolState, false)),
        ];
      } else {
        const details = entry.text.split("\n").slice(1).join("\n");
        lines = [header, ...renderToolDetails(details, width, entry.toolState)];
      }
    } else if (entry.kind === "user") {
      lines = renderUserSurface(entry.text.length > 0 ? entry.text : "…", width);
    } else if (entry.kind === "assistant" || entry.kind === "thinking") {
      const text = entry.text.length > 0 ? entry.text : "…";
      const innerWidth = entry.kind === "thinking" ? Math.max(1, width - 2) : width;
      const markdown = new Markdown(
        text,
        0,
        0,
        markdownTheme,
        entry.kind === "thinking" ? { color: paint.thinking, italic: true } : undefined,
      );
      const content = markdown.render(innerWidth);
      lines = entry.kind === "thinking"
        ? content.map((line) => `${paint.thinking("│")} ${line}`)
        : content;
    } else if (entry.kind === "error") {
      lines = renderNotice(entry.text.length > 0 ? entry.text : "Unknown error", width, true);
    } else {
      lines = renderNotice(entry.text.length > 0 ? entry.text : "…", width, false);
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
      const piece = pieceCounts.get(source.entryId) ?? 0;
      pieceCounts.set(source.entryId, piece + 1);
      const entry = this.createEntry(`history:${source.entryId}:${piece}`, kind, text, complete);
      projectedEntries.push(entry);
      return entry;
    };

    for (const source of entries) {
      const thinking = contentText(source.content, "thinking");
      const text = contentText(source.content, "text");
      if (source.role === "user") {
        addProjected(source, "user", text ?? historyOmissions(source));
      } else if (source.role === "assistant") {
        if (thinking) addProjected(source, "thinking", thinking);
        if (text) addProjected(source, "assistant", text);
        for (const block of source.content) {
          if (block.type !== "tool_call") continue;
          const toolEntry = addProjected(source, "tool", "");
          toolEntry.toolCallId = block.toolCallId;
          const tool: ToolProjection = {
            entry: toolEntry,
            id: block.toolCallId,
            name: block.toolName,
            args: formatJson(block.args, MAX_TOOL_ARGS),
            omitted: [...(block.omittedFields ?? [])],
          };
          projectedTools.set(block.toolCallId, tool);
          projectToolState(tool, "done");
        }
        if (source.error) addProjected(source, "error", source.error);
      } else if (source.role === "tool") {
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
          tool.output = block.text;
          tool.omitted = [...new Set([...tool.omitted, ...(block.omittedFields ?? [])])];
          projectToolState(tool, block.isError ? "failed" : "done");
          tool.entry.diffText = !block.isError && looksLikeDiff(block.text) ? block.text : undefined;
          projectedTools.delete(block.toolCallId);
        }
      } else {
        addProjected(source, source.error ? "error" : "system", text || historyOmissions(source) || source.error || "Session event");
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
    if (tool.entry.text === text && tool.entry.toolName === tool.name && tool.entry.toolState === state) return;
    tool.entry.text = text;
    tool.entry.toolName = tool.name;
    tool.entry.toolState = state;
    this.touchEntry(tool.entry);
    this.markOutputChanged();
  }

  private addTool(toolCallId: string, complete: boolean): ConversationEntry {
    const entry = this.add("tool", "", complete);
    entry.toolCallId = toolCallId;
    return entry;
  }

  private isToolExpanded(entry: ConversationEntry): boolean {
    if (!entry.toolCallId) return true;
    return this.toolExpansionOverrides.get(entry.toolCallId) ?? this.toolsExpanded;
  }

  private add(kind: EntryKind, text: string, complete = true): ConversationEntry {
    const entry = this.createEntry(`live:${++this.liveEntrySequence}`, kind, text, complete);
    this.entries.push(entry);
    this.markOutputChanged();
    while (this.entries.length - this.historyDisplayCount > MAX_LIVE_ENTRIES) {
      const [removed] = this.entries.splice(this.historyDisplayCount, 1);
      if (removed === this.currentAssistant) this.currentAssistant = undefined;
      if (removed === this.currentThinking) this.currentThinking = undefined;
      for (const [key, value] of this.tools) if (value.entry === removed) this.tools.delete(key);
      if (
        removed?.toolCallId
        && !this.entries.some((candidate) => candidate.toolCallId === removed.toolCallId)
      ) this.toolExpansionOverrides.delete(removed.toolCallId);
    }
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
  private markOutputChanged(): void {
    this.revisionValue += 1;
    this.outputRevisionValue += 1;
  }
}

function projectToolState(tool: ToolProjection, state: ToolState): void {
  const parts = [`${tool.name} ${state}`];
  if (tool.args) parts.push(`args\n${tool.args}`);
  if (tool.omitted.length > 0) parts.push(`omitted: ${tool.omitted.join(", ")}`);
  if (tool.output) parts.push(`result\n${tool.output}`);
  tool.entry.text = safeTerminalText(parts.join("\n"));
  tool.entry.toolName = tool.name;
  tool.entry.toolState = state;
  tool.entry.renderRevision += 1;
  tool.entry.renderCache = undefined;
}

export class DockStatusLine implements Component {
  private snapshotValue: InstanceSnapshot;
  private activity = "ready";
  private activityPhase: RunActivityState["phase"] | "status" = "status";
  private activityAnimated = false;
  private activityFrame = 0;
  private connection = "connected";
  private controller = "observing";
  private autoCompaction: boolean | undefined;

  constructor(snapshot: InstanceSnapshot) { this.snapshotValue = snapshot; }
  update(snapshot: InstanceSnapshot): void { this.snapshotValue = snapshot; }
  setActivity(activity: string | RunActivityState, animated = false): void {
    const label = safeTerminalLine(typeof activity === "string" ? activity : activity.label);
    const phase = typeof activity === "string" ? inferActivityPhase(label) : activity.phase;
    const nextAnimated = typeof activity === "string" ? animated : activity.animated;
    if (label !== this.activity || phase !== this.activityPhase || nextAnimated !== this.activityAnimated) this.activityFrame = 0;
    this.activity = label;
    this.activityPhase = phase;
    this.activityAnimated = nextAnimated;
  }
  tickActivity(): boolean {
    if (!this.activityAnimated) return false;
    this.activityFrame = (this.activityFrame + 1) % ACTIVITY_FRAMES.length;
    return true;
  }
  setConnection(connection: string): void { this.connection = safeTerminalLine(connection); }
  setController(controller: string): void { this.controller = safeTerminalLine(controller); }
  setAutoCompaction(enabled: boolean | undefined): void { this.autoCompaction = enabled; }
  invalidate(): void {}

  render(width: number): string[] {
    const boundedWidth = Math.max(1, width);
    const snapshot = this.snapshotValue;
    const model = snapshot.executor.model
      ? `${safeTerminalLine(snapshot.executor.model.provider)}/${safeTerminalLine(snapshot.executor.model.id)}`
      : "no model";
    const name = safeTerminalLine(snapshot.name || shortId(snapshot.id));
    const state = snapshot.lifecycle === "active" ? snapshot.execution : snapshot.lifecycle;
    const activitySymbol = this.activityAnimated
      ? ACTIVITY_FRAMES[this.activityFrame] ?? "·"
      : activitySymbolFor(this.activityPhase);
    const activity = activityPainter(this.activityPhase)(`${activitySymbol} ${this.activity}`);
    const statuses = Object.entries(snapshot.extensionStatus);
    const firstLine = fitFooterSegments(boundedWidth, [
      activity,
      statePainter(state)(state),
      ...(snapshot.pending.total > 0 ? [paint.queue(`queue ${snapshot.pending.total}`)] : []),
      paint.primary(model),
      ...(snapshot.executor.thinkingLevel ? [paint.thinking(`think ${snapshot.executor.thinkingLevel}`)] : []),
      paint.muted(`${this.connection}/${this.controller}`),
      ...(statuses.length > 0
        ? [paint.faint(`ext ${statuses.map(([key, value]) => `${safeTerminalLine(key)}:${safeTerminalLine(value)}`).join(",")}`)]
        : []),
    ]);

    const metricSegments = formatMetricSegments(snapshot);
    const secondLine = fitFooterSegments(boundedWidth, [
      paint.bold(paint.primary(name)),
      paint.muted(safeTerminalLine(snapshot.cwd)),
      paint.faint(`d:${shortId(snapshot.id)} p:${shortId(snapshot.executor.piSessionId)}`),
      ...metricSegments.map(paint.muted),
      paint.faint(`cmp ${this.autoCompaction === undefined ? "—" : this.autoCompaction ? "A" : "M"}`),
    ]);
    return [firstLine, secondLine];
  }
}

const ACTIVITY_FRAMES = ["·", "•", "●", "•"] as const;

function renderUserSurface(text: string, width: number): string[] {
  if (width < 3) return wrapPlainText(text, width).map(paint.userSurface);
  const bodyWidth = width - 2;
  return wrapPlainText(text, bodyWidth).map((line) => {
    const body = padToVisibleWidth(` ${line}`, width - 1);
    return `${paint.user("▎")}${paint.userSurface(body)}`;
  });
}

function renderToolHeader(entry: ConversationEntry, width: number, expanded: boolean): string {
  const state = entry.toolState ?? (entry.complete ? "done" : "running");
  const icon = state === "failed" ? "×" : state === "done" ? "✓" : "◆";
  const title = `${icon} ${entry.toolName ?? "tool"} ${state}`;
  const hint = expanded ? "· Alt+O fold" : "· Alt+O detail";
  return truncateToWidth(`${toolStatePainter(state)(title)} ${paint.faint(hint)}`, width);
}

function renderToolDetails(text: string, width: number, state: ToolState | undefined): string[] {
  if (text.length === 0) return [];
  const bodyWidth = Math.max(1, width - 2);
  return text
    .split("\n")
    .flatMap((line) => wrapTextWithAnsi(line || " ", bodyWidth))
    .map((line) => renderToolDetailLine(line, width, state, true));
}

function renderToolDetailLine(
  line: string,
  width: number,
  state: ToolState | undefined,
  surface: boolean,
): string {
  if (width < 3) return truncateToWidth(line, width);
  const bodyWidth = width - 2;
  const body = truncateToWidth(line || " ", bodyWidth);
  const projected = surface ? paint.toolSurface(padToVisibleWidth(body, bodyWidth)) : body;
  return `${toolStatePainter(state)("│")} ${projected}`;
}

function renderNotice(text: string, width: number, error: boolean): string[] {
  if (width < 3) return wrapPlainText(text, width).map(error ? paint.error : paint.muted);
  const bodyWidth = width - 2;
  return wrapPlainText(text, bodyWidth).map((line, index) => {
    const marker = index === 0 ? (error ? "!" : "·") : "│";
    return `${error ? paint.error(marker) : paint.faint(marker)} ${error ? paint.error(line) : paint.muted(line)}`;
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
  if (!metrics) return ["↑— ↓—", "ctx —", "cache —", "$—"];
  const denominator = metrics.tokens.input + metrics.tokens.cacheRead + metrics.tokens.cacheWrite;
  const cache = denominator > 0 ? `${Math.round((metrics.tokens.cacheRead / denominator) * 100)}%` : "—";
  const context = metrics.context
    ? `${formatCount(metrics.context.tokens)}/${formatCount(metrics.context.contextWindow)}${metrics.context.percent === null ? "" : ` ${Math.round(metrics.context.percent)}%`}`
    : "—";
  return [
    `↑${formatCount(metrics.tokens.input)} ↓${formatCount(metrics.tokens.output)}`,
    `ctx ${context}`,
    `cache ${cache}`,
    `$${metrics.cost.toFixed(4)}`,
  ];
}

function inferActivityPhase(label: string): RunActivityState["phase"] | "status" {
  const normalized = label.toLowerCase();
  if (/host|disconnect|closed|stopped/u.test(normalized)) return "disconnected";
  if (/error|failed|unavailable/u.test(normalized)) return "error";
  if (/abort|stopping/u.test(normalized)) return "aborting";
  if (/queue/u.test(normalized)) return "queued";
  if (/tool/u.test(normalized)) return "tool";
  if (/think/u.test(normalized)) return "thinking";
  if (/respond|stream/u.test(normalized)) return "responding";
  if (/retry/u.test(normalized)) return "retry";
  if (/compact/u.test(normalized)) return "compaction";
  if (/submit/u.test(normalized)) return "submitting";
  if (/wait/u.test(normalized)) return "waiting";
  if (/ready|idle/u.test(normalized)) return "idle";
  return "status";
}

function activitySymbolFor(phase: RunActivityState["phase"] | "status"): string {
  if (phase === "idle") return "○";
  if (phase === "queued") return "◇";
  if (phase === "tool") return "◆";
  if (phase === "compaction") return "◈";
  if (phase === "interaction") return "?";
  if (phase === "error" || phase === "disconnected") return "×";
  return "●";
}

function activityPainter(phase: RunActivityState["phase"] | "status"): (text: string) => string {
  if (phase === "error" || phase === "disconnected") return paint.error;
  if (phase === "queued" || phase === "interaction") return paint.queue;
  if (phase === "thinking") return paint.thinking;
  if (phase === "idle" || phase === "status") return paint.muted;
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

function safeTerminalLine(text: string): string {
  return safeTerminalText(text).replace(/[\t\n]/gu, " ");
}

function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}

function stringArraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
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
