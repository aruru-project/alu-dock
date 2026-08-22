import type { InstanceSnapshot } from "../core/managed-instance.js";
import type { ControlRequest } from "./protocol.js";

export interface MachineRouteIdentity {
  mainInstanceId: string;
  nativeInstanceId: string;
  mainHostEpoch: string;
  nativeHostEpoch: string;
  mainKey?: string;
}

/** The sole Main/native identity translation boundary. Opaque payloads are never visited. */
export function requestForNativeHost(request: ControlRequest, route: MachineRouteIdentity | undefined): ControlRequest {
  const copy = structuredClone(request) as ControlRequest;
  const params = copy.params as Record<string, unknown>;
  delete params.hostId;
  if (!route) return copy;
  if (params.instanceId === route.mainInstanceId) params.instanceId = route.nativeInstanceId;
  if (isCursor(params.since)) {
    if (params.since.instanceId === route.mainInstanceId) params.since.instanceId = route.nativeInstanceId;
    if (params.since.hostEpoch === route.mainHostEpoch) params.since.hostEpoch = route.nativeHostEpoch;
  }
  return copy;
}

export function snapshotForMain(snapshot: InstanceSnapshot, mainInstanceId: string, mainHostEpoch: string, mainKey: string | undefined): InstanceSnapshot {
  const nativeHostEpoch = snapshot.ownerHostEpoch ?? snapshot.eventCursor.hostEpoch;
  return mapSnapshot(structuredClone(snapshot), {
    mainInstanceId,
    nativeInstanceId: snapshot.id,
    mainHostEpoch,
    nativeHostEpoch,
    ...(mainKey === undefined ? {} : { mainKey }),
  });
}

export function recordForMainHost(input: unknown, route: MachineRouteIdentity): unknown {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;
  const envelope = structuredClone(input) as Record<string, unknown>;
  if (envelope.hostEpoch === route.nativeHostEpoch) envelope.hostEpoch = route.mainHostEpoch;
  if (envelope.kind === "event" && isRecord(envelope.event)) envelope.event = mapEvent(envelope.event, route);
  else if (envelope.kind === "response" && envelope.ok === true && isRecord(envelope.result)) envelope.result = mapResult(envelope.result, route);
  else mapFrameRoot(envelope, route);
  return envelope;
}

function mapResult(source: Record<string, unknown>, route: MachineRouteIdentity): Record<string, unknown> {
  const result = structuredClone(source);
  if (result.instanceId === route.nativeInstanceId) result.instanceId = route.mainInstanceId;
  if (isSnapshot(result.instance)) result.instance = mapSnapshot(result.instance, route);
  if (Array.isArray(result.instances)) result.instances = result.instances.map((item) => isSnapshot(item) ? mapSnapshot(item, route) : item);
  if (isRecord(result.page)) result.page = mapPage(result.page, route);
  if (isRecord(result.receipt)) {
    if (result.receipt.instanceId === route.nativeInstanceId) result.receipt.instanceId = route.mainInstanceId;
    if (result.receipt.forgottenId === route.nativeInstanceId) result.receipt.forgottenId = route.mainInstanceId;
  }
  if (isObservedStatus(result.target)) result.target = mapObservedStatus(result.target, route);
  return result;
}

function mapPage(source: Record<string, unknown>, route: MachineRouteIdentity): Record<string, unknown> {
  const page = structuredClone(source);
  if (isCursor(page.earliest)) page.earliest = mapCursor(page.earliest, route);
  if (isCursor(page.latest)) page.latest = mapCursor(page.latest, route);
  if (Array.isArray(page.events)) page.events = page.events.map((item) => isEvent(item) ? mapEvent(item, route) : item);
  return page;
}

function mapFrameRoot(frame: Record<string, unknown>, route: MachineRouteIdentity): void {
  if (frame.instanceId === route.nativeInstanceId) frame.instanceId = route.mainInstanceId;
  if (isSnapshot(frame.instance)) frame.instance = mapSnapshot(frame.instance, route);
  if (isRecord(frame.event) && isEvent(frame.event)) frame.event = mapEvent(frame.event, route);
  // Stream metadata such as deliverable, entry, error details, presentation and bytes is opaque.
}

function mapSnapshot(source: InstanceSnapshot, route: MachineRouteIdentity): InstanceSnapshot {
  const snapshot = structuredClone(source);
  if (snapshot.id === route.nativeInstanceId) snapshot.id = route.mainInstanceId;
  if (snapshot.ownerHostEpoch === route.nativeHostEpoch) snapshot.ownerHostEpoch = route.mainHostEpoch;
  snapshot.eventCursor = mapCursor(snapshot.eventCursor, route);
  if (route.mainKey === undefined) delete snapshot.key;
  else snapshot.key = route.mainKey;
  return snapshot;
}

function mapEvent(source: Record<string, unknown>, route: MachineRouteIdentity): Record<string, unknown> {
  const event = structuredClone(source);
  if (event.instanceId === route.nativeInstanceId) event.instanceId = route.mainInstanceId;
  // DockEvent.data is Agent/extension/user-owned JSON and is intentionally untouched.
  return event;
}

function mapCursor<T extends { hostEpoch: string; instanceId: string }>(source: T, route: MachineRouteIdentity): T {
  const cursor = structuredClone(source);
  if (cursor.instanceId === route.nativeInstanceId) cursor.instanceId = route.mainInstanceId;
  if (cursor.hostEpoch === route.nativeHostEpoch) cursor.hostEpoch = route.mainHostEpoch;
  return cursor;
}

function mapObservedStatus<T extends { id: string }>(source: T, route: MachineRouteIdentity): T {
  const status = structuredClone(source);
  if (status.id === route.nativeInstanceId) status.id = route.mainInstanceId;
  return status;
}

function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function isSnapshot(value: unknown): value is InstanceSnapshot {
  return isRecord(value) && typeof value.id === "string" && typeof value.creationOperationId === "string" && typeof value.runtimeGeneration === "number" && typeof value.lifecycle === "string" && isCursor(value.eventCursor);
}
function isCursor(value: unknown): value is { hostEpoch: string; instanceId: string; runtimeGeneration: number; sequence: number } {
  return isRecord(value) && typeof value.hostEpoch === "string" && typeof value.instanceId === "string" && typeof value.runtimeGeneration === "number" && typeof value.sequence === "number";
}
function isEvent(value: unknown): value is Record<string, unknown> { return isRecord(value) && typeof value.type === "string" && typeof value.instanceId === "string" && "data" in value; }
function isObservedStatus(value: unknown): value is { id: string; cwd: string; lifecycle: string; execution: string } {
  return isRecord(value) && typeof value.id === "string" && typeof value.cwd === "string" && typeof value.lifecycle === "string" && typeof value.execution === "string";
}
