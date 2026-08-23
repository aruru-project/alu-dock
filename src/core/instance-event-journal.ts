import { sliceSemanticHistory } from "./history-pagination.js";
import { cloneJson } from "./json-value.js";
import type {
  DockEvent,
  EventCursor,
  EventDataMap,
  EventPage,
  HistoryEntryDto,
  HistoryPageDto,
  InstanceSnapshot,
} from "./instance-dto.js";

export class InvalidHistoryCursorError extends Error {
  constructor(readonly beforeEntryId: string) {
    super(`History entry ${beforeEntryId} does not belong to the current session branch`);
    this.name = "InvalidHistoryCursorError";
  }
}

export interface InstanceEventJournalOptions {
  hostEpoch: string;
  instanceId: string;
  initialRuntimeGeneration: number;
  eventCapacity?: number;
  initialHistory?: HistoryEntryDto[];
  onCursorAdvanced?: (cursor: EventCursor) => void;
}

/**
 * One instance's observable event and history journal. ManagedInstance decides
 * which facts to publish; this class alone owns their replay and reconnect state.
 */
export class InstanceEventJournal {
  private readonly hostEpoch: string;
  private readonly instanceId: string;
  private publishedRuntimeGeneration: number;
  private readonly eventCapacity: number;
  private readonly eventLog: DockEvent[] = [];
  private readonly activeConversationEvents: DockEvent[] = [];
  private readonly subscribers = new Set<(event: DockEvent) => void>();
  private history: HistoryEntryDto[];
  private historyRevisionValue = 1;
  private nextEventSequence = 1;
  private readonly onCursorAdvanced: ((cursor: EventCursor) => void) | undefined;

  constructor(options: InstanceEventJournalOptions) {
    this.hostEpoch = options.hostEpoch;
    this.instanceId = options.instanceId;
    this.publishedRuntimeGeneration = options.initialRuntimeGeneration;
    const requestedCapacity = options.eventCapacity ?? 500;
    this.eventCapacity = Number.isFinite(requestedCapacity) && requestedCapacity >= 1
      ? Math.floor(requestedCapacity)
      : 500;
    this.history = options.initialHistory ?? [];
    this.onCursorAdvanced = options.onCursorAdvanced;
  }

  cursor(): EventCursor {
    return this.cursorAt(this.nextEventSequence - 1);
  }

  eventsSince(since: EventCursor | number = 0): EventPage {
    const domainChanged = typeof since !== "number" && (
      since.hostEpoch !== this.hostEpoch
      || since.instanceId !== this.instanceId
      || since.runtimeGeneration !== this.publishedRuntimeGeneration
    );
    const sequence = domainChanged ? 0 : typeof since === "number" ? since : since.sequence;
    const earliestSequence = this.eventLog[0]?.sequence ?? this.nextEventSequence;
    const latestSequence = this.nextEventSequence - 1;
    return {
      events: this.eventLog
        .filter((event) => event.sequence > sequence)
        .map((event) => cloneJson(event)),
      earliest: this.cursorAt(earliestSequence),
      latest: this.cursorAt(latestSequence),
      truncated: domainChanged || sequence < earliestSequence - 1,
    };
  }

  subscribe(listener: (event: DockEvent) => void): () => void {
    this.subscribers.add(listener);
    return () => this.subscribers.delete(listener);
  }

  append<K extends keyof EventDataMap>(type: K, data: EventDataMap[K], occurredAt: string): DockEvent {
    const event = {
      scope: "instance" as const,
      sequence: this.nextEventSequence++,
      instanceId: this.instanceId,
      runtimeGeneration: this.publishedRuntimeGeneration,
      occurredAt,
      type,
      data,
    } as DockEvent;
    this.captureActiveConversationEvent(event);
    this.eventLog.push(event);
    if (this.eventLog.length > this.eventCapacity) this.eventLog.shift();
    this.onCursorAdvanced?.(this.cursor());

    // Store the event before notifying clients, and isolate broken observers
    // from the Worker's synchronous event chain.
    for (const subscriber of this.subscribers) {
      try { subscriber(cloneJson(event)); }
      catch { /* Transport owners report and detach their own failures. */ }
    }
    return event;
  }

  resetGeneration(runtimeGeneration: number): void {
    this.publishedRuntimeGeneration = runtimeGeneration;
    this.nextEventSequence = 1;
    this.eventLog.length = 0;
    this.activeConversationEvents.length = 0;
  }

  replaceHistory(history: HistoryEntryDto[]): void {
    this.history = history;
    this.historyRevisionValue += 1;
  }

  installConversationCheckpoint(history: HistoryEntryDto[]): void {
    this.replaceHistory(history);
    this.releasePersistedConversation(this.nextEventSequence - 1);
  }

  historyPage(beforeEntryId: string | undefined, limit: number): HistoryPageDto {
    let requestedEnd = this.history.length;
    if (beforeEntryId !== undefined) {
      requestedEnd = this.history.findIndex((entry) => entry.entryId === beforeEntryId);
      if (requestedEnd < 0) throw new InvalidHistoryCursorError(beforeEntryId);
    }
    const page = sliceSemanticHistory(this.history, requestedEnd, Math.max(1, Math.min(200, Math.floor(limit))));
    const entries = cloneJson(this.history.slice(page.start, page.end));
    return {
      historyRevision: this.historyRevisionValue,
      entries,
      hasEarlier: page.hasEarlier,
      ...(page.hasEarlier && entries[0] ? { nextBeforeEntryId: entries[0].entryId } : {}),
    };
  }

  conversationBootstrapEvents(replayEvents: readonly DockEvent[], instance: InstanceSnapshot): DockEvent[] {
    const conversation = this.activeConversationEvents
      .filter((event) => event.runtimeGeneration === instance.runtimeGeneration)
      .map((event) => cloneJson(event));
    const activeInteractionId = instance.activeInteraction?.id;
    const interaction = activeInteractionId === undefined ? undefined : replayEvents.findLast((event) => (
      event.type === "interaction.requested" && event.data.interactionId === activeInteractionId
    ));
    if (interaction === undefined || conversation.some((event) => event.sequence === interaction.sequence)) return conversation;
    return [...conversation, cloneJson(interaction)].sort((left, right) => (
      left.runtimeGeneration - right.runtimeGeneration || left.sequence - right.sequence
    ));
  }

  private captureActiveConversationEvent(event: DockEvent): void {
    if (!isConversationFrame(event)) return;
    const copy = cloneJson(event);
    const previous = this.activeConversationEvents.at(-1);
    if (previous?.type === "message.delta" && copy.type === "message.delta"
      && previous.data.messageId === copy.data.messageId
      && previous.data.block === copy.data.block
      && previous.data.delta.length + copy.data.delta.length <= 8_000) {
      previous.data.delta += copy.data.delta;
      previous.sequence = copy.sequence;
      previous.occurredAt = copy.occurredAt;
      return;
    }
    if (copy.type === "tool.args_updated" || copy.type === "tool.output_updated") {
      const superseded = this.activeConversationEvents.findLastIndex((candidate) => (
        candidate.type === copy.type && candidate.data.toolCallId === copy.data.toolCallId
      ));
      if (superseded >= 0) this.activeConversationEvents.splice(superseded, 1);
    }
    this.activeConversationEvents.push(copy);
  }

  private releasePersistedConversation(sequence: number): void {
    const retained = this.activeConversationEvents.filter((event) => event.sequence > sequence);
    this.activeConversationEvents.splice(0, this.activeConversationEvents.length, ...retained);
  }

  private cursorAt(sequence: number): EventCursor {
    return { hostEpoch: this.hostEpoch, instanceId: this.instanceId, runtimeGeneration: this.publishedRuntimeGeneration, sequence };
  }
}

function isConversationFrame(event: DockEvent): event is Extract<DockEvent, {
  type: "message.submitted" | "message.delta" | "message.completed"
    | "tool.started" | "tool.args_updated" | "tool.output_updated" | "tool.completed";
}> {
  return event.type === "message.submitted"
    || event.type === "message.delta"
    || event.type === "message.completed"
    || event.type === "tool.started"
    || event.type === "tool.args_updated"
    || event.type === "tool.output_updated"
    || event.type === "tool.completed";
}
