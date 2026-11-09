import { randomUUID } from "node:crypto";

import { AgentUnavailableBeforeEffectError } from "../core/agent-worker.js";
import type {
  ContentBlockDto,
  ConversationContentPageDto,
  ConversationHistoryEntryDto,
  ConversationHistoryPageDto,
  DockEvent,
  HistoryEntryDto,
  InstanceSnapshot,
} from "../core/instance-dto.js";
import {
  CROSS_INSTANCE_TRUST,
  MAX_OBSERVATION_ACTIVE_WATCHES_PER_SOURCE,
  MAX_OBSERVATION_LIST_ITEMS,
  MAX_OBSERVATION_MESSAGE_LIMIT,
  MAX_OBSERVATION_PAGE_CHARS,
  MAX_OBSERVATION_REPLY_CHARS,
  OBSERVATION_DATA_NOTICE,
  type InstanceObservation,
  type ObservationConversationPage,
  type ObservationDeliverySink,
  type ObservationMessageType,
  type ObservationNotification,
  type ObservationRequest,
  type ObservationResult,
  type ObservationTerminalReason,
  type ObservationWatchReceipt,
  type ObservedInstanceStatus,
} from "../core/instance-observation.js";

interface ObservationLiveConversation {
  instance: InstanceSnapshot;
  /** Conversation frames the target has not saved yet, such as the reply it is writing. */
  liveEvents: DockEvent[];
}

interface InstanceObservationQueryPort {
  listSnapshots(): InstanceSnapshot[];
  getSnapshot(instanceId: string): InstanceSnapshot;
  readLiveConversation(instanceId: string): Promise<ObservationLiveConversation | undefined>;
  /**
   * The target's saved conversation, newest page first. Entries carry previews; one whose
   * preview is not the whole message is read whole through readConversationContent.
   */
  readConversationHistory(instanceId: string, cursor: string | undefined, limit: number): Promise<ConversationHistoryPageDto | undefined>;
  readConversationContent(instanceId: string, contentRef: string, cursor: string | undefined): Promise<ConversationContentPageDto>;
  subscribe(instanceId: string, listener: (snapshot: InstanceSnapshot) => void): (() => void) | undefined;
  sourceAuthorized(instanceId: string): boolean;
}

const HISTORY_SCAN_PAGE_ITEMS = 20;
const MAX_HISTORY_SCAN_PAGES_PER_CALL = 10;
const MAX_OBSERVATION_CURSORS = 128;
const MAX_OBSERVED_ERROR_CHARS = 2_000;

interface InternalObservationMessage {
  type: ObservationMessageType;
  text: string;
  timestamp?: string;
}

interface ObservationCursorState {
  sourceInstanceId: string;
  targetInstanceId: string;
  runtimeGeneration: number;
  /** The target's conversation revision; another one means it switched session or branch. */
  revision: string;
  typesKey: string;
  /** Messages read and not returned yet, oldest first. */
  pending: InternalObservationMessage[];
  /** Saved entries fetched and not read yet, oldest first. */
  entries: ConversationHistoryEntryDto[];
  historyCursor?: string;
  hasEarlier: boolean;
}

interface ObservationWatch {
  receipt: ObservationWatchReceipt;
  sourceInstanceId: string;
  targetInstanceId: string;
  unsubscribe: () => void;
}

export class InstanceObservationService {
  private readonly sinks = new Map<string, ObservationDeliverySink>();
  private readonly pendingDeliveries = new Map<string, Map<string, ObservationNotification>>();
  private readonly watches = new Map<string, ObservationWatch>();
  private readonly sourceTails = new Map<string, Promise<void>>();
  private readonly cursors = new Map<string, ObservationCursorState>();

  constructor(
    private readonly port: InstanceObservationQueryPort,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly createId: () => string = randomUUID,
  ) {}

  observe(sourceInstanceId: string, request: ObservationRequest): Promise<ObservationResult> {
    return this.withSource(sourceInstanceId, async () => {
      this.assertSourceAuthorized(sourceInstanceId);
      if (request.type === "cancel") {
        return { type: "cancel", cancelledWatchIds: this.cancelLocked(sourceInstanceId, request.watchId) };
      }
      if (request.type === "list") return this.list(sourceInstanceId, request.includeHistory === true);
      const target = this.resolveTarget(sourceInstanceId, request.target);
      if (request.type === "inspect") return { type: "inspect", result: await this.inspect(sourceInstanceId, target, request) };
      return this.watchLocked(sourceInstanceId, target);
    });
  }

  configureSource(
    sourceInstanceId: string,
    enabled: boolean,
    commit: () => Promise<void>,
  ): Promise<void> {
    return this.withSource(sourceInstanceId, async () => {
      await commit();
      if (!enabled) this.cancelLocked(sourceInstanceId);
    });
  }

  cancelSource(sourceInstanceId: string): Promise<string[]> {
    return this.withSource(sourceInstanceId, async () => this.cancelLocked(sourceInstanceId));
  }

  attachSink(sourceInstanceId: string, sink: ObservationDeliverySink): () => void {
    this.sinks.set(sourceInstanceId, sink);
    void this.withSource(sourceInstanceId, () => this.flushPendingLocked(sourceInstanceId, sink));
    return () => { if (this.sinks.get(sourceInstanceId) === sink) this.sinks.delete(sourceInstanceId); };
  }

  async forgetInstances(instanceIds: readonly string[]): Promise<void> {
    const forgotten = new Set(instanceIds);
    for (const instanceId of forgotten) {
      await this.cancelSource(instanceId);
      this.sinks.delete(instanceId);
      this.pendingDeliveries.delete(instanceId);
    }
    for (const [token, cursor] of this.cursors) {
      if (forgotten.has(cursor.sourceInstanceId) || forgotten.has(cursor.targetInstanceId)) this.cursors.delete(token);
    }
    const completions: Promise<void>[] = [];
    for (const [watchId, watch] of this.watches) {
      if (!forgotten.has(watch.targetInstanceId)) continue;
      const firedAt = this.now();
      const target: ObservedInstanceStatus = {
        ...watch.receipt.target,
        lifecycle: "stopped",
        execution: "unavailable",
        compacting: false,
        executionChangedAt: firedAt,
        runStartedAt: undefined,
      };
      completions.push(this.withSource(watch.sourceInstanceId, async () => {
        await this.completeWatchLocked(watchId, "execution_unavailable", target, true, false);
      }));
    }
    await Promise.all(completions);
  }

  private list(sourceInstanceId: string, includeHistory: boolean): ObservationResult {
    const all = this.visibleTargets(sourceInstanceId);
    const selected = includeHistory
      ? all
      : all.filter((item) => item.lifecycle === "active" || item.lifecycle === "stopping");
    const instances = selected.slice(0, MAX_OBSERVATION_LIST_ITEMS).map(observationStatus);
    return {
      type: "list",
      result: {
        trust: CROSS_INSTANCE_TRUST,
        observedAt: this.now(),
        instances,
        total: selected.length,
        truncated: instances.length < selected.length,
        includesHistory: includeHistory,
      },
    };
  }

  private async inspect(
    sourceInstanceId: string,
    target: InstanceSnapshot,
    request: Extract<ObservationRequest, { type: "inspect" }>,
  ): Promise<InstanceObservation> {
    const limit = normalizeLimit(request.limit);
    const types = normalizeTypes(request.types);
    const typesKey = types.join(",");
    const observedAt = this.now();

    let status = observationStatus(target);
    let state: ObservationCursorState;
    if (request.cursor !== undefined) {
      const saved = this.cursors.get(request.cursor);
      if (!saved || saved.sourceInstanceId !== sourceInstanceId || saved.targetInstanceId !== target.id) {
        throw new Error("Observation cursor is stale or belongs to another source or target");
      }
      if (saved.runtimeGeneration !== target.runtimeGeneration || saved.typesKey !== typesKey) {
        throw new Error("Observation cursor no longer matches the target generation or message filters");
      }
      const boundary = await this.port.readConversationHistory(target.id, undefined, 1);
      if (!boundary
        || boundary.instance.runtimeGeneration !== saved.runtimeGeneration
        || boundary.revision !== saved.revision) {
        throw new Error("Observation cursor is stale because the target conversation changed");
      }
      status = observationStatus(boundary.instance);
      state = cloneCursorState(saved);
    } else {
      // Unsaved frames first: a message saved between the two reads then shows twice, never not at all.
      const live = await this.port.readLiveConversation(target.id);
      const saved = live && await this.port.readConversationHistory(target.id, undefined, HISTORY_SCAN_PAGE_ITEMS);
      if (!live || !saved) return { trust: CROSS_INSTANCE_TRUST, observedAt, status };
      status = observationStatus(live.instance);
      state = {
        sourceInstanceId,
        targetInstanceId: target.id,
        runtimeGeneration: saved.instance.runtimeGeneration,
        revision: saved.revision,
        typesKey,
        pending: projectUnsavedEvents(live.liveEvents, types),
        entries: saved.entries,
        ...(saved.nextCursor === undefined ? {} : { historyCursor: saved.nextCursor }),
        hasEarlier: saved.hasEarlier,
      };
    }

    await this.fillFromHistory(state, types, limit);
    const selected = takePage(state.pending, limit);
    const hasEarlier = state.pending.length > 0 || state.entries.length > 0 || state.hasEarlier;
    const nextCursor = hasEarlier ? this.storeCursor(state) : undefined;
    const conversation: ObservationConversationPage = {
      messages: selected.map((message) => ({ ...message })),
      hasEarlier,
      ...(nextCursor === undefined ? {} : { nextCursor }),
    };
    return { trust: CROSS_INSTANCE_TRUST, observedAt, status, conversation };
  }

  private async fillFromHistory(
    state: ObservationCursorState,
    types: readonly ObservationMessageType[],
    requested: number,
  ): Promise<void> {
    let pages = 0;
    while (state.pending.length < requested) {
      const entry = state.entries.pop();
      if (entry !== undefined) {
        state.pending.unshift(...await this.readEntry(state.targetInstanceId, entry, types));
        continue;
      }
      if (!state.hasEarlier || pages >= MAX_HISTORY_SCAN_PAGES_PER_CALL) return;
      const page = await this.port.readConversationHistory(state.targetInstanceId, state.historyCursor, HISTORY_SCAN_PAGE_ITEMS);
      if (!page) throw new Error("Observation target no longer has readable conversation history");
      if (page.instance.runtimeGeneration !== state.runtimeGeneration || page.revision !== state.revision) {
        throw new Error("Observation cursor is stale because the target conversation changed");
      }
      state.entries = page.entries;
      if (page.nextCursor === undefined) delete state.historyCursor;
      else state.historyCursor = page.nextCursor;
      state.hasEarlier = page.hasEarlier;
      pages += 1;
    }
  }

  /** One saved entry as messages. A preview that is not the whole message is read whole. */
  private async readEntry(
    targetInstanceId: string,
    item: ConversationHistoryEntryDto,
    types: readonly ObservationMessageType[],
  ): Promise<InternalObservationMessage[]> {
    const { entry } = item;
    const allowed = new Set(types);
    const type = recordDefaultType(entry);
    if (!isConversationMessage(entry) || (!allowed.has(type) && !allowed.has("other"))) return [];
    const blocks = item.contentComplete ? entry.content : await this.readWholeContent(targetInstanceId, item.contentRef);
    return projectBlocks(type, blocks, entry.timestamp, allowed);
  }

  /** The blocks a message shows, its text whole; thinking and tool blocks are not shown. */
  private async readWholeContent(targetInstanceId: string, contentRef: string): Promise<ContentBlockDto[]> {
    const blocks: ContentBlockDto[] = [];
    const texts = new Map<number, { type: "text"; text: string }>();
    let cursor: string | undefined;
    do {
      const page = await this.port.readConversationContent(targetInstanceId, contentRef, cursor);
      for (const chunk of page.chunks) {
        if (chunk.type === "text") {
          const block = texts.get(chunk.blockIndex);
          if (block) block.text += chunk.text;
          else {
            const created = { type: "text" as const, text: chunk.text };
            texts.set(chunk.blockIndex, created);
            blocks.push(created);
          }
        } else if (chunk.type === "image_ref" || (chunk.type === "image" && chunk.offset === 0)) {
          blocks.push({ type: "image", mimeType: chunk.mimeType });
        } else if (chunk.type === "omitted") {
          blocks.push({ type: "omitted", kind: chunk.kind, description: chunk.description });
        }
      }
      cursor = page.complete ? undefined : page.nextCursor;
    } while (cursor !== undefined);
    return blocks;
  }

  private async watchLocked(sourceInstanceId: string, target: InstanceSnapshot): Promise<ObservationResult> {
    // One watch per pair: a second one would wake the source twice for the same finish.
    const existing = [...this.watches.values()].find((watch) => watch.sourceInstanceId === sourceInstanceId && watch.targetInstanceId === target.id);
    if (existing) return { type: "watch", status: "watching", receipt: existing.receipt };
    const activeForSource = [...this.watches.values()].filter((watch) => watch.sourceInstanceId === sourceInstanceId).length;
    if (activeForSource >= MAX_OBSERVATION_ACTIVE_WATCHES_PER_SOURCE) {
      throw new Error(`Dock observation is limited to ${MAX_OBSERVATION_ACTIVE_WATCHES_PER_SOURCE} active watches per source instance`);
    }
    const watchId = this.createId();
    const receipt: ObservationWatchReceipt = {
      watchId,
      target: observationStatus(target),
      registeredAt: this.now(),
    };
    const immediateReason = observationTerminalReason(target);
    if (immediateReason) return { type: "watch", status: "completed", completion: await this.completion(receipt, immediateReason, receipt.target, finishedWithReply(target, immediateReason)) };
    const unsubscribe = this.port.subscribe(target.id, (snapshot) => {
      const reason = observationTerminalReason(snapshot);
      if (!reason) return;
      const captured = observationStatus(snapshot);
      const withReply = finishedWithReply(snapshot, reason);
      void this.withSource(sourceInstanceId, async () => {
        await this.completeWatchLocked(watchId, reason, captured, true, withReply);
      });
    });
    if (!unsubscribe) {
      return { type: "watch", status: "completed", completion: notification(receipt, "execution_unavailable", unavailableStatus(receipt.target, this.now()), this.now()) };
    }
    this.watches.set(watchId, { receipt, sourceInstanceId, targetInstanceId: target.id, unsubscribe });
    const afterSubscribe = this.port.getSnapshot(target.id);
    const racedReason = observationTerminalReason(afterSubscribe);
    if (!racedReason) return { type: "watch", status: "watching", receipt };
    const withReply = finishedWithReply(afterSubscribe, racedReason);
    const completion = await this.completeWatchLocked(watchId, racedReason, observationStatus(afterSubscribe), false, withReply);
    return { type: "watch", status: "completed", completion: completion ?? await this.completion(receipt, racedReason, observationStatus(afterSubscribe), withReply) };
  }

  private async completeWatchLocked(
    watchId: string,
    reason: ObservationTerminalReason,
    target: ObservedInstanceStatus,
    deliver: boolean,
    withReply: boolean,
  ): Promise<ObservationNotification | undefined> {
    const watch = this.watches.get(watchId);
    if (!watch) return undefined;
    this.watches.delete(watchId);
    watch.unsubscribe();
    const completion = await this.completion(watch.receipt, reason, target, withReply);
    if (deliver) await this.deliverLocked(watch.sourceInstanceId, completion);
    return completion;
  }

  /** A Work that finished its turn hands its final reply along, so the watcher need not read it back. */
  private async completion(receipt: ObservationWatchReceipt, reason: ObservationTerminalReason, target: ObservedInstanceStatus, withReply: boolean): Promise<ObservationNotification> {
    const reply = withReply ? await this.finalReply(receipt.target.id) : undefined;
    return notification(receipt, reason, reply === undefined ? target : { ...target, reply }, this.now());
  }

  private async finalReply(targetInstanceId: string): Promise<string | undefined> {
    try {
      // Saved messages only: text still being written belongs to a run that started since.
      const saved = await this.port.readConversationHistory(targetInstanceId, undefined, HISTORY_SCAN_PAGE_ITEMS);
      for (const item of [...(saved?.entries ?? [])].reverse()) {
        const reply = (await this.readEntry(targetInstanceId, item, ["assistant"])).at(-1)?.text;
        if (reply !== undefined) return shortenReply(reply, MAX_OBSERVATION_REPLY_CHARS);
      }
      return undefined;
    } catch {
      return undefined; // The completion still says it finished; dock_inspect can read the reply.
    }
  }

  private async deliverLocked(sourceInstanceId: string, completion: ObservationNotification): Promise<void> {
    if (!this.sourceCanReceive(sourceInstanceId)) return;
    const sink = this.sinks.get(sourceInstanceId);
    if (!sink) {
      this.queuePending(sourceInstanceId, completion);
      return;
    }
    try {
      await sink(completion);
    } catch (error) {
      if (error instanceof AgentUnavailableBeforeEffectError) this.queuePending(sourceInstanceId, completion);
      if (this.sinks.get(sourceInstanceId) === sink) this.sinks.delete(sourceInstanceId);
    }
  }

  private async flushPendingLocked(sourceInstanceId: string, sink: ObservationDeliverySink): Promise<void> {
    const pending = this.pendingDeliveries.get(sourceInstanceId);
    if (!pending || pending.size === 0 || !this.sourceCanReceive(sourceInstanceId)) return;
    for (const [watchId, completion] of [...pending]) {
      if (this.sinks.get(sourceInstanceId) !== sink || !pending.has(watchId)) return;
      try {
        await sink(completion);
        pending.delete(watchId);
      } catch (error) {
        if (!(error instanceof AgentUnavailableBeforeEffectError)) pending.delete(watchId);
        if (this.sinks.get(sourceInstanceId) === sink) this.sinks.delete(sourceInstanceId);
        break;
      }
    }
    if (pending.size === 0) this.pendingDeliveries.delete(sourceInstanceId);
  }

  private queuePending(sourceInstanceId: string, completion: ObservationNotification): void {
    const pending = this.pendingDeliveries.get(sourceInstanceId) ?? new Map<string, ObservationNotification>();
    if (!pending.has(completion.watchId) && pending.size >= MAX_OBSERVATION_ACTIVE_WATCHES_PER_SOURCE) {
      pending.delete(pending.keys().next().value!);
    }
    pending.set(completion.watchId, completion);
    this.pendingDeliveries.set(sourceInstanceId, pending);
  }

  private cancelLocked(sourceInstanceId: string, watchId?: string): string[] {
    const cancelled = new Set<string>();
    for (const [candidateId, watch] of this.watches) {
      if (watch.sourceInstanceId !== sourceInstanceId || (watchId !== undefined && candidateId !== watchId)) continue;
      this.watches.delete(candidateId);
      watch.unsubscribe();
      cancelled.add(candidateId);
    }
    const pending = this.pendingDeliveries.get(sourceInstanceId);
    if (pending) {
      for (const candidateId of [...pending.keys()]) {
        if (watchId !== undefined && candidateId !== watchId) continue;
        pending.delete(candidateId);
        cancelled.add(candidateId);
      }
      if (pending.size === 0) this.pendingDeliveries.delete(sourceInstanceId);
    }
    return [...cancelled];
  }

  resolveTarget(sourceInstanceId: string, selector: string): InstanceSnapshot {
    if (selector === sourceInstanceId) throw new Error("An instance cannot observe itself");
    const candidates = this.visibleTargets(sourceInstanceId);
    const exactId = candidates.find((item) => item.id === selector);
    if (exactId) return this.assertNotSelf(sourceInstanceId, exactId);
    const live = candidates.filter((item) => item.lifecycle === "active" || item.lifecycle === "stopping");
    const exactKey = live.find((item) => item.key === selector);
    if (exactKey) return this.assertNotSelf(sourceInstanceId, exactKey);
    const matches = new Map<string, InstanceSnapshot>();
    for (const item of live) {
      if (item.id.startsWith(selector) || item.name === selector) matches.set(item.id, item);
    }
    if (matches.size !== 1) throw new Error(`No single live Work you can see matches ${selector}; run dock_list and use its id.`);
    return this.assertNotSelf(sourceInstanceId, [...matches.values()][0]!);
  }

  private visibleTargets(sourceInstanceId: string): InstanceSnapshot[] {
    const source = this.port.getSnapshot(sourceInstanceId);
    return this.port.listSnapshots().filter((target) => dockTargetVisible(source, target));
  }

  private assertNotSelf(sourceInstanceId: string, target: InstanceSnapshot): InstanceSnapshot {
    if (target.id === sourceInstanceId) throw new Error("An instance cannot observe itself");
    return target;
  }

  private assertSourceAuthorized(sourceInstanceId: string): void {
    if (!this.port.sourceAuthorized(sourceInstanceId)) throw new Error("Dock observation is not granted for this source instance");
    const source = this.port.getSnapshot(sourceInstanceId);
    if (source.lifecycle !== "active") throw new Error("Dock observation requires an active source instance");
  }

  private sourceCanReceive(sourceInstanceId: string): boolean {
    try {
      return this.port.sourceAuthorized(sourceInstanceId) && this.port.getSnapshot(sourceInstanceId).lifecycle === "active";
    } catch {
      return false;
    }
  }

  private storeCursor(state: ObservationCursorState): string {
    const token = this.createId();
    this.cursors.set(token, cloneCursorState(state));
    while (this.cursors.size > MAX_OBSERVATION_CURSORS) this.cursors.delete(this.cursors.keys().next().value!);
    return token;
  }

  private withSource<T>(sourceInstanceId: string, action: () => Promise<T>): Promise<T> {
    const previous = this.sourceTails.get(sourceInstanceId) ?? Promise.resolve();
    const result = previous.then(action);
    const tail = result.then(() => undefined, () => undefined);
    this.sourceTails.set(sourceInstanceId, tail);
    void tail.finally(() => {
      if (this.sourceTails.get(sourceInstanceId) === tail) this.sourceTails.delete(sourceInstanceId);
    });
    return result;
  }
}

export function observationStatus(snapshot: InstanceSnapshot): ObservedInstanceStatus {
  return {
    id: snapshot.id,
    ...(snapshot.parentId === undefined ? {} : { parentId: snapshot.parentId }),
    ...(snapshot.key === undefined ? {} : { key: snapshot.key }),
    ...(snapshot.name === undefined ? {} : { name: snapshot.name }),
    cwd: snapshot.cwd,
    lifecycle: snapshot.lifecycle,
    execution: snapshot.execution,
    compacting: snapshot.compacting,
    executionChangedAt: snapshot.executionChangedAt,
    ...(snapshot.runStartedAt === undefined ? {} : { runStartedAt: snapshot.runStartedAt }),
    runtimeGeneration: snapshot.runtimeGeneration,
    ...(snapshot.lastError === undefined ? {} : { lastError: truncateText(snapshot.lastError, MAX_OBSERVED_ERROR_CHARS).text }),
    ...(snapshot.executor.model === undefined ? {} : { model: { provider: snapshot.executor.model.provider, id: snapshot.executor.model.id } }),
    ...(snapshot.executor.thinkingLevel === undefined ? {} : { thinkingLevel: snapshot.executor.thinkingLevel }),
  };
}

function unavailableStatus(status: ObservedInstanceStatus, timestamp: string): ObservedInstanceStatus {
  return { ...status, lifecycle: "stopped", execution: "unavailable", compacting: false, executionChangedAt: timestamp, runStartedAt: undefined };
}

function observationTerminalReason(snapshot: InstanceSnapshot): ObservationTerminalReason | undefined {
  if (snapshot.lifecycle === "stopped") return "stopped";
  if (snapshot.lifecycle === "host_lost") return "host_lost";
  if (snapshot.lifecycle === "runtime_error") return "runtime_error";
  if (snapshot.execution === "failed") return "execution_failed";
  if (snapshot.execution === "unavailable") return "execution_unavailable";
  // Queued input starts another run, so the Work is not done while any is waiting.
  if (snapshot.execution === "idle" && !snapshot.compacting && snapshot.pending.total === 0) return "idle";
  return undefined;
}

/** Only a turn that ended normally has a final reply; an interrupted one would show an older answer. */
function finishedWithReply(snapshot: InstanceSnapshot, reason: ObservationTerminalReason): boolean {
  return reason === "idle" && snapshot.lastRun === "succeeded";
}

function notification(
  receipt: ObservationWatchReceipt,
  reason: ObservationTerminalReason,
  target: ObservedInstanceStatus,
  firedAt: string,
): ObservationNotification {
  return { trust: CROSS_INSTANCE_TRUST, notice: OBSERVATION_DATA_NOTICE, watchId: receipt.watchId, firedAt, reason, target };
}

function normalizeLimit(value: number | undefined): number {
  if (value === undefined) return 1;
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_OBSERVATION_MESSAGE_LIMIT) {
    throw new Error(`Observation message limit must be between 1 and ${MAX_OBSERVATION_MESSAGE_LIMIT}`);
  }
  return value;
}

function normalizeTypes(value: readonly ObservationMessageType[] | undefined): ObservationMessageType[] {
  const types = value === undefined ? ["user", "assistant", "other"] as ObservationMessageType[] : [...new Set(value)];
  if (types.length === 0 || types.some((item) => item !== "user" && item !== "assistant" && item !== "other")) {
    throw new Error("Observation message types must contain user, assistant, or other");
  }
  return types.sort();
}

function isConversationMessage(entry: HistoryEntryDto): boolean {
  return entry.visibility === "conversation"
    && (entry.kind === "message" || entry.kind === "custom_message")
    && entry.source !== "tool";
}

function recordDefaultType(entry: HistoryEntryDto): ObservationMessageType {
  if (entry.source === "user") return "user";
  if (entry.source === "assistant") return "assistant";
  return "other";
}

function projectBlocks(
  defaultType: ObservationMessageType,
  blocks: readonly ContentBlockDto[],
  timestamp: string | undefined,
  allowed: ReadonlySet<ObservationMessageType>,
): InternalObservationMessage[] {
  const messages: InternalObservationMessage[] = [];
  for (const block of blocks) {
    if (block.type === "thinking" || block.type === "tool_call" || block.type === "tool_result") continue;
    const type = block.type === "text" ? defaultType : "other";
    if (!allowed.has(type)) continue;
    const text = blockText(block);
    if (!text) continue;
    const previous = messages.at(-1);
    if (previous?.type === type) previous.text = `${previous.text}\n${text}`;
    else messages.push({ type, text, ...(timestamp === undefined ? {} : { timestamp }) });
  }
  return messages;
}

function blockText(block: ContentBlockDto): string {
  if (block.type === "text") return cleanText(block.text);
  if (block.type === "image") return `[image: ${cleanText(block.mimeType)}]`;
  if (block.type === "omitted") return `[${block.kind} omitted: ${cleanText(block.description)}]`;
  return "";
}

/**
 * Messages the target has not finished, so has not saved: what a user just sent and the reply
 * being written. A finished message is read from its saved entry, whole.
 */
function projectUnsavedEvents(events: readonly DockEvent[], types: readonly ObservationMessageType[]): InternalObservationMessage[] {
  const allowed = new Set(types);
  const finished = new Set(events.flatMap((event) => event.type === "message.completed" ? [event.data.messageId] : []));
  const messages = new Map<string, InternalObservationMessage>();
  for (const event of events) {
    if (event.type === "message.submitted" && !finished.has(event.data.messageId)) {
      messages.set(event.data.messageId, { type: "user", text: cleanText(event.data.text), timestamp: event.occurredAt });
    } else if (event.type === "message.delta" && event.data.block === "text" && !finished.has(event.data.messageId)) {
      const current = messages.get(event.data.messageId);
      if (current) current.text += cleanText(event.data.delta);
      else messages.set(event.data.messageId, { type: "assistant", text: cleanText(event.data.delta), timestamp: event.occurredAt });
    }
  }
  return [...messages.values()].filter((message) => allowed.has(message.type) && message.text.length > 0);
}

function cleanText(value: string): string {
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu, "�");
}

const REPLY_SHORTENED = "\n[…shortened; dock_inspect shows the whole reply]";
const MESSAGE_CONTINUES = "\n[…continues; dock_inspect with the continuation cursor shows the rest of this message]";
const MESSAGE_CONTINUED = "[…continued from the page before]\n";

/** At most `limit` characters of a reply; a longer one keeps its start and says where the rest is. */
function shortenReply(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, safeEnd(text, limit - REPLY_SHORTENED.length))}${REPLY_SHORTENED}`;
}

/** The same completion, its reply at most `limit` characters. */
export function withReplyShortened(notification: ObservationNotification, limit: number): ObservationNotification {
  const reply = notification.target.reply;
  if (reply === undefined || reply.length <= limit) return notification;
  return { ...notification, target: { ...notification.target, reply: shortenReply(reply, limit) } };
}

/**
 * Takes the newest pending messages that fit one page. A message that alone is too long for a
 * page shows its start; the rest stays pending, so the next page begins with it.
 */
function takePage(pending: InternalObservationMessage[], limit: number): InternalObservationMessage[] {
  const page: InternalObservationMessage[] = [];
  let chars = 0;
  while (page.length < limit && pending.length > 0) {
    const next = pending.at(-1)!;
    if (chars + next.text.length <= MAX_OBSERVATION_PAGE_CHARS) {
      page.unshift(pending.pop()!);
      chars += next.text.length;
      continue;
    }
    if (page.length === 0) {
      const end = safeEnd(next.text, MAX_OBSERVATION_PAGE_CHARS - MESSAGE_CONTINUES.length);
      page.unshift({ ...next, text: `${next.text.slice(0, end)}${MESSAGE_CONTINUES}` });
      pending[pending.length - 1] = { ...next, text: `${MESSAGE_CONTINUED}${next.text.slice(end)}` };
    }
    break;
  }
  return page;
}

/** `end`, moved back one if it would split a surrogate pair. */
function safeEnd(text: string, end: number): number {
  const high = text.charCodeAt(end - 1);
  return high >= 0xd800 && high <= 0xdbff ? end - 1 : end;
}

function truncateText(value: string, max: number): { text: string; truncated: boolean } {
  if (value.length <= max) return { text: value, truncated: false };
  const end = max > 20 ? max - 14 : max;
  const high = value.charCodeAt(end - 1);
  const safeEnd = high >= 0xd800 && high <= 0xdbff ? end - 1 : end;
  return { text: `${value.slice(0, safeEnd)}\n[…truncated]`, truncated: true };
}

function cloneCursorState(state: ObservationCursorState): ObservationCursorState {
  return { ...state, pending: state.pending.map((message) => ({ ...message })), entries: [...state.entries] };
}

/** Native children communicate through their parent; top-level peers stay unrestricted. */
export function dockTargetVisible(source: InstanceSnapshot, target: InstanceSnapshot): boolean {
  if (source.id === target.id) return false;
  if (source.parentId !== undefined) return target.id === source.parentId;
  return target.parentId === undefined || target.parentId === source.id;
}
