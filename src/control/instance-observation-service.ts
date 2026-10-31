import { randomUUID } from "node:crypto";

import { AgentUnavailableBeforeEffectError } from "../core/agent-worker.js";
import type { ContentBlockDto, DockEvent, HistoryEntryDto, HistoryPageDto, InstanceSnapshot } from "../core/instance-dto.js";
import {
  CROSS_INSTANCE_TRUST,
  MAX_OBSERVATION_ACTIVE_WATCHES_PER_SOURCE,
  MAX_OBSERVATION_LIST_ITEMS,
  MAX_OBSERVATION_MESSAGE_LIMIT,
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

interface ObservationConversationBootstrap {
  instance: InstanceSnapshot;
  recentHistory: HistoryEntryDto[];
  historyRevision: number;
  historyTruncated: boolean;
  liveEvents: DockEvent[];
}

interface InstanceObservationQueryPort {
  listSnapshots(): InstanceSnapshot[];
  getSnapshot(instanceId: string): InstanceSnapshot;
  readConversationBootstrap(instanceId: string, historyLimit: number): Promise<ObservationConversationBootstrap | undefined>;
  readHistoryPage(instanceId: string, beforeEntryId: string | undefined, limit: number): Promise<(HistoryPageDto & { instance: InstanceSnapshot }) | undefined>;
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
  historyRevision: number;
  typesKey: string;
  pending: InternalObservationMessage[];
  beforeEntryId?: string;
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
        await this.completeWatchLocked(watchId, "execution_unavailable", target, true);
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
      const boundary = await this.port.readHistoryPage(target.id, undefined, 1);
      if (!boundary
        || boundary.instance.runtimeGeneration !== saved.runtimeGeneration
        || boundary.historyRevision !== saved.historyRevision) {
        throw new Error("Observation cursor is stale because the target conversation changed");
      }
      status = observationStatus(boundary.instance);
      state = cloneCursorState(saved);
    } else {
      const bootstrap = await this.port.readConversationBootstrap(target.id, HISTORY_SCAN_PAGE_ITEMS);
      if (!bootstrap) return { trust: CROSS_INSTANCE_TRUST, observedAt, status };
      status = observationStatus(bootstrap.instance);
      state = {
        sourceInstanceId,
        targetInstanceId: target.id,
        runtimeGeneration: bootstrap.instance.runtimeGeneration,
        historyRevision: bootstrap.historyRevision,
        typesKey,
        pending: [
          ...projectHistoryEntries(bootstrap.recentHistory, types),
          ...projectLiveEvents(bootstrap.liveEvents, types),
        ],
        ...(bootstrap.recentHistory[0] === undefined ? {} : { beforeEntryId: bootstrap.recentHistory[0].entryId }),
        hasEarlier: bootstrap.historyTruncated,
      };
    }

    await this.fillFromHistory(state, types, limit);
    const split = Math.max(0, state.pending.length - limit);
    const selected = state.pending.slice(split);
    state.pending = state.pending.slice(0, split);
    const hasEarlier = state.pending.length > 0 || state.hasEarlier;
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
    while (state.pending.length < requested && state.hasEarlier && pages < MAX_HISTORY_SCAN_PAGES_PER_CALL) {
      const page = await this.port.readHistoryPage(state.targetInstanceId, state.beforeEntryId, HISTORY_SCAN_PAGE_ITEMS);
      if (!page) throw new Error("Observation target no longer has readable conversation history");
      if (page.instance.runtimeGeneration !== state.runtimeGeneration || page.historyRevision !== state.historyRevision) {
        throw new Error("Observation cursor is stale because the target conversation changed");
      }
      state.pending.unshift(...projectHistoryEntries(page.entries, types));
      state.beforeEntryId = page.entries[0]?.entryId;
      state.hasEarlier = page.hasEarlier;
      pages += 1;
    }
  }

  private watchLocked(sourceInstanceId: string, target: InstanceSnapshot): Promise<ObservationResult> {
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
    if (immediateReason) {
      return Promise.resolve({ type: "watch", status: "completed", completion: notification(receipt, immediateReason, receipt.target, this.now()) });
    }
    const unsubscribe = this.port.subscribe(target.id, (snapshot) => {
      const reason = observationTerminalReason(snapshot);
      if (!reason) return;
      const captured = observationStatus(snapshot);
      void this.withSource(sourceInstanceId, async () => {
        await this.completeWatchLocked(watchId, reason, captured, true);
      });
    });
    if (!unsubscribe) {
      return Promise.resolve({ type: "watch", status: "completed", completion: notification(receipt, "execution_unavailable", unavailableStatus(receipt.target, this.now()), this.now()) });
    }
    this.watches.set(watchId, { receipt, sourceInstanceId, targetInstanceId: target.id, unsubscribe });
    const afterSubscribe = this.port.getSnapshot(target.id);
    const racedReason = observationTerminalReason(afterSubscribe);
    if (!racedReason) return Promise.resolve({ type: "watch", status: "watching", receipt });
    return this.completeWatchLocked(watchId, racedReason, observationStatus(afterSubscribe), false).then((completion) => ({
      type: "watch" as const,
      status: "completed" as const,
      completion: completion ?? notification(receipt, racedReason, observationStatus(afterSubscribe), this.now()),
    }));
  }

  private async completeWatchLocked(
    watchId: string,
    reason: ObservationTerminalReason,
    target: ObservedInstanceStatus,
    deliver: boolean,
  ): Promise<ObservationNotification | undefined> {
    const watch = this.watches.get(watchId);
    if (!watch) return undefined;
    this.watches.delete(watchId);
    watch.unsubscribe();
    const completion = notification(watch.receipt, reason, target, this.now());
    if (deliver) await this.deliverLocked(watch.sourceInstanceId, completion);
    return completion;
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
    if (matches.size !== 1) throw new Error(`Observation target is missing or ambiguous among live siblings: ${selector}`);
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
  if (snapshot.execution === "idle" && !snapshot.compacting) return "idle";
  return undefined;
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

function projectHistoryEntries(entries: readonly HistoryEntryDto[], types: readonly ObservationMessageType[]): InternalObservationMessage[] {
  const allowed = new Set(types);
  return entries.flatMap((entry) => entry.visibility === "conversation"
      && (entry.kind === "message" || entry.kind === "custom_message")
      && entry.source !== "tool"
    ? projectBlocks(recordDefaultType(entry), entry.content, entry.timestamp, allowed)
    : []);
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

function projectLiveEvents(events: readonly DockEvent[], types: readonly ObservationMessageType[]): InternalObservationMessage[] {
  const allowed = new Set(types);
  const order: string[] = [];
  const groups = new Map<string, InternalObservationMessage[]>();
  const set = (key: string, messages: InternalObservationMessage[]): void => {
    if (!groups.has(key)) order.push(key);
    groups.set(key, messages.filter((item) => allowed.has(item.type) && item.text.length > 0));
  };
  for (const event of events) {
    if (event.type === "message.submitted") {
      set(`message:${event.data.messageId}`, [{ type: "user", text: cleanText(event.data.text), timestamp: event.occurredAt }]);
    } else if (event.type === "message.delta" && event.data.block === "text") {
      const key = `message:${event.data.messageId}`;
      const current = groups.get(key)?.[0];
      const text = `${current?.text ?? ""}${cleanText(event.data.delta)}`;
      set(key, [{ type: "assistant", text, timestamp: current?.timestamp ?? event.occurredAt }]);
    } else if (event.type === "message.completed" && event.data.role !== "tool") {
      const type: ObservationMessageType = event.data.role === "user" ? "user" : event.data.role === "assistant" ? "assistant" : "other";
      set(`message:${event.data.messageId}`, projectBlocks(type, event.data.content, event.occurredAt, allowed));
    }
  }
  return order.flatMap((key) => groups.get(key) ?? []);
}

function cleanText(value: string): string {
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu, "�");
}

function truncateText(value: string, max: number): { text: string; truncated: boolean } {
  if (value.length <= max) return { text: value, truncated: false };
  const end = max > 20 ? max - 14 : max;
  const high = value.charCodeAt(end - 1);
  const safeEnd = high >= 0xd800 && high <= 0xdbff ? end - 1 : end;
  return { text: `${value.slice(0, safeEnd)}\n[…truncated]`, truncated: true };
}

function cloneCursorState(state: ObservationCursorState): ObservationCursorState {
  return { ...state, pending: state.pending.map((message) => ({ ...message })) };
}

/** Native children communicate through their parent; top-level peers stay unrestricted. */
export function dockTargetVisible(source: InstanceSnapshot, target: InstanceSnapshot): boolean {
  if (source.id === target.id) return false;
  if (source.parentId !== undefined) return target.id === source.parentId;
  return target.parentId === undefined || target.parentId === source.id;
}
