import { TextDecoder } from "node:util";
import { MAX_DOCK_TRANSFER_BYTES } from "../core/transport-bounds.js";
import type { DockEvent } from "../core/managed-instance.js";
import { FileSendWindow } from "./file-transfer.js";
import { FileIdleTimer } from "./file-channel.js";
import { instanceRecordHeader } from "./file-framing.js";
import { FILE_TRANSFER_CHUNK_BYTES, parseInstanceRecordFrame, parseInstanceHistory, parseInstanceReady, parseControlResponse, parseControlEventEnvelope, parseInstanceReadResult, parseFollowResult, validatePageEvent, ProtocolValidationError, type InstanceReadResult, type FollowResult, } from "./protocol.js";
function invalid(message: string): never { throw new ProtocolValidationError("invalid_response", message); }
/** One bounded logical record at a time. Credit acknowledges assembly, not application commit. */
export class InstanceRecordChannel {
    readonly abort = new AbortController();
    private readonly window = new FileSendWindow(this.abort.signal);
    private readonly idle: FileIdleTimer;
    private recordIndex = 0;
    private sendIndex = 0;
    private chunks: Buffer[] = [];
    private count = 0;
    private size = 0;
    private consumedBytes = 0;
    private receivedWireBytes = 0;
    private inTransitBytes = 0;
    private progressScheduled = false;
    private active = true;
    started = false;
    constructor(readonly requestId: string, readonly hostEpoch: string, private readonly direction: "send" | "receive", private readonly output: (frame: Record<string, unknown>) => Promise<void>, private readonly failed: (error: unknown) => void, private readonly onProgress?: (wire: number, consumed: number) => void) {
        this.idle = new FileIdleTimer(() => { const error = new Error("Instance record delivery was idle for too long"); this.cancel(error); failed(error); });
        this.idle.activity();
    }
    activity(): void { if ((this.active || this.window.pending) && !this.abort.signal.aborted)
        this.idle.activity(); }
    waiting(): void { this.active = true; this.activity(); }
    quiescent(): void {
        this.active = false;
        // An empty application queue is not quiet while bytes still await credit.
        if (!this.window.pending) this.idle.dispose();
    }
    cancel(error: unknown = new Error("Instance records closed")): void {
        this.abort.abort(error);
        this.idle.dispose();
        this.chunks = [];
    }
    observeWire(bytes: number, partial: string): void {
        this.receivedWireBytes += bytes;
        // Any incomplete physical input starts a stall deadline. An unknown or
        // short header cannot keep renewing it just by trickling arbitrary bytes.
        if (this.direction === "receive" && partial.length > 0 && !this.active) this.waiting();
        const header = instanceRecordHeader(partial);
        if (header?.requestId !== this.requestId || header.hostEpoch !== this.hostEpoch)
            return;
        this.started = true;
        // A second observation after parsing may see the same partial header.
        // It can arm a newly quiet receiver, but cannot manufacture progress.
        if (bytes === 0) return;
        this.waiting();
        if (this.progressScheduled)
            return;
        this.progressScheduled = true;
        setImmediate(() => {
            this.progressScheduled = false;
            if (!this.abort.signal.aborted)
                void this.progress().catch(error => { this.cancel(error); this.failed(error); });
        });
    }
    private frame(body: Record<string, unknown>): Record<string, unknown> {
        return { kind: body.kind, version: 2, requestId: this.requestId, hostEpoch: this.hostEpoch, ...body };
    }
    private async progress(): Promise<void> {
        await this.output(this.frame({ kind: "instance_record_progress", receivedWireBytes: this.receivedWireBytes, consumedBytes: this.consumedBytes }));
    }
    async consume(raw: unknown): Promise<unknown | undefined> {
        this.abort.signal.throwIfAborted();
        const frame = parseInstanceRecordFrame(raw, this.requestId, this.hostEpoch);
        if (frame.kind === "instance_record_progress") {
            if (this.direction !== "send")
                invalid("Unexpected receiver progress");
            if (this.window.progress(frame)) {
                this.activity();
                this.onProgress?.(frame.receivedWireBytes, frame.consumedBytes);
            }
            if (!this.active && !this.window.pending) this.idle.dispose();
            return;
        }
        if (frame.kind === "instance_record_activity") {
            if (frame.inTransitBytes > this.inTransitBytes) {
                this.inTransitBytes = frame.inTransitBytes;
                if (this.direction === "send")
                    this.activity();
                else
                    this.waiting();
            }
            return;
        }
        if (this.direction !== "receive")
            invalid("Unexpected instance record input");
        this.started = true;
        this.waiting();
        if (frame.recordIndex !== this.recordIndex || frame.index !== this.chunks.length || (this.chunks.length > 0 && frame.count !== this.count))
            invalid("Instance record fragments are out of order");
        this.count = frame.count;
        const bytes = Buffer.from(frame.data, "base64");
        this.size += bytes.length;
        if (this.size > MAX_DOCK_TRANSFER_BYTES)
            invalid("Instance record exceeds its aggregate bound");
        this.chunks.push(bytes);
        this.consumedBytes += bytes.length;
        await this.progress();
        if (this.chunks.length !== this.count)
            return;
        const data = Buffer.concat(this.chunks, this.size);
        this.chunks = [];
        this.size = 0;
        this.count = 0;
        this.recordIndex++;
        return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(data)) as unknown;
    }
    async send(record: unknown): Promise<void> {
        this.waiting();
        const bytes = Buffer.from(JSON.stringify(record), "utf8");
        if (bytes.length > MAX_DOCK_TRANSFER_BYTES)
            throw new ProtocolValidationError("response_too_large", "Instance record exceeds its aggregate bound");
        const count = Math.ceil(bytes.length / FILE_TRANSFER_CHUNK_BYTES);
        for (let index = 0; index < count; index++) {
            const part = bytes.subarray(index * FILE_TRANSFER_CHUNK_BYTES, (index + 1) * FILE_TRANSFER_CHUNK_BYTES);
            await this.window.reserve(part.length);
            this.started = true;
            await this.output(this.frame({ kind: "instance_record_fragment", recordIndex: this.sendIndex, index, count, data: part.toString("base64") }));
            this.activity();
        }
        this.sendIndex++;
    }
    async drained(): Promise<void> { await this.window.drained(); }
    finish(): void { if (this.chunks.length)
        invalid("Instance record ended before all fragments arrived"); }
}
/** Staged bootstrap is visible only after the exact ready marker. Uses the canonical V2 parsers. */
export class InstanceRecordInitial {
    private result?: InstanceReadResult | FollowResult;
    private readonly historyIds = new Set<string>();
    private eventsStarted = false;
    ready = false;
    constructor(private readonly read: boolean, private readonly requestId: string, private readonly hostEpoch: string) { }
    consume(raw: unknown): InstanceReadResult | FollowResult | undefined {
        if (this.ready)
            invalid("Initial instance records already committed");
        if (!this.result) {
            const response = parseControlResponse(raw, this.requestId, this.hostEpoch);
            if (!response.ok)
                invalid("Record metadata must be successful");
            this.result = this.read ? parseInstanceReadResult(response.result) : parseFollowResult(response.result);
            if (this.result.page.events.length || (this.read && (this.result as InstanceReadResult).recentHistory.length))
                invalid("Record metadata must have empty arrays");
            if (this.result.page.latest.hostEpoch !== this.hostEpoch)
                invalid("Record metadata belongs to another host");
            return;
        }
        const kind = (raw as {
            kind?: unknown;
        })?.kind;
        if (kind === "instance_history") {
            if (!("recentHistory" in this.result) || this.eventsStarted)
                invalid("History record is out of order");
            const entry = parseInstanceHistory(raw, this.requestId, this.hostEpoch);
            if (this.historyIds.has(entry.entryId))
                invalid("Duplicate history entry");
            this.historyIds.add(entry.entryId);
            this.result.recentHistory.push(entry);
            return;
        }
        if (kind === "event") {
            this.eventsStarted = true;
            const event = parseControlEventEnvelope(raw, this.requestId, this.hostEpoch).event;
            const events = this.result.page.events;
            validatePageEvent(event, this.result.page.latest, events.at(-1)?.sequence ?? -1);
            events.push(event);
            return;
        }
        const marker = parseInstanceReady(raw, this.requestId, this.hostEpoch);
        if (marker.historyEntries !== this.historyIds.size || marker.eventCount !== this.result.page.events.length)
            invalid("Instance ready counts do not match");
        this.ready = true;
        return this.result;
    }
    finish(): void { if (!this.ready)
        invalid("Instance initial delivery ended before ready"); }
}
export function recordEvent(requestId: string, hostEpoch: string, event: DockEvent): Record<string, unknown> {
    return { kind: "event", version: 2, requestId, hostEpoch, event };
}
