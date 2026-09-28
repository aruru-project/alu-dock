import { MAX_ATTACHMENT_CHUNK_BYTES } from "../core/instance-attachments.js";
import { FileReceiver } from "./file-transfer.js";
import type { Socket } from "node:net";
import { FileChannel } from "./file-channel.js";
import { encodeJsonLine, JsonLineDecoder } from "./json-lines.js";
import {
  FILE_TRANSFER_CAPABILITY, parseControlResponse, parseFileTransferFrame, parseHelloReply,
  ProtocolHelloRejectedError, ProtocolValidationError,
  type ClientHello, type FileTransferRequest, type FileTransferSummary,
} from "./protocol.js";

export class FileCapabilityMissingError extends Error {}
export class FileResponseError extends Error {
  constructor(readonly code: string, message: string, readonly details?: import("../core/json-value.js").JsonObject) { super(message); }
}
interface ClientFileOptions {
  openSocket: () => Socket;
  hello: ClientHello;
  request: FileTransferRequest;
  maximumBytes: number;
  signal?: AbortSignal;
  timeoutMs: number;
}

/** Single negotiated receiver for all file-backed business calls. No business DTO parsing here. */
export function receiveClientFile(options: ClientFileOptions & {
  sink: (bytes: Uint8Array) => void | Promise<void>;
  onReady?: (metadata: unknown) => void;
}): Promise<{ result: unknown; summary: FileTransferSummary; hostEpoch: string }> {
  return new Promise((resolve, reject) => {
    const socket = options.openSocket(), decoder = new JsonLineDecoder();
    let channel: FileChannel | undefined, epoch = "", summary: FileTransferSummary | undefined;
    let result: unknown, terminal = false, settled = false, wireBytes = 0, ending = false;
    let phase: "hello" | "ready" | "body" | "response" = "hello";
    let timer: NodeJS.Timeout;
    const abort = () => finish(options.signal?.reason ?? new Error("File read cancelled"));
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      channel?.cancel(error ?? new Error("File transfer ended"));
      socket.destroy();
      if (error) reject(error);
      else resolve({ result, summary: summary!, hostEpoch: epoch });
    };
    const consume = async (line: string) => {
      if (settled) return;
      if (!line) { if (channel) throw new ProtocolValidationError("invalid_response", "Empty file record"); return; }
      if (terminal) throw new ProtocolValidationError("invalid_response", "Data after file response");
      const raw = JSON.parse(line) as unknown;
      if (phase === "hello") {
        let ack;
        try { ack = parseHelloReply(raw, options.hello.requestId); }
        catch (error) {
          if (error instanceof ProtocolHelloRejectedError && error.rejection.code === "capability_missing" && error.rejection.missing?.includes(FILE_TRANSFER_CAPABILITY)) throw new FileCapabilityMissingError();
          throw error;
        }
        for (const required of options.hello.requiredCapabilities) if (!ack.capabilities.includes(required)) throw new ProtocolValidationError("protocol_incompatible", "Host did not negotiate required capabilities");
        epoch = ack.host.hostEpoch;
        channel = new FileChannel(socket, options.request.requestId, epoch);
        channel.observeWire(wireBytes);
        clearTimeout(timer);
        phase = "ready";
        socket.write(encodeJsonLine(options.request));
        return;
      }
      if ((raw as { kind?: string }).kind === "response") {
        const response = parseControlResponse(raw, options.request.requestId, epoch);
        if (!response.ok) {
          if (phase === "ready" && response.error.code === "capability_missing" && Array.isArray(response.error.details?.missing) && response.error.details.missing.includes(FILE_TRANSFER_CAPABILITY)) throw new FileCapabilityMissingError();
          throw new FileResponseError(response.error.code, response.error.message, response.error.details);
        }
        if (phase !== "response" || !summary) throw new ProtocolValidationError("invalid_response", "File response preceded transfer completion");
        result = response.result;
        terminal = true;
        return;
      }
      if ((raw as {kind?:string}).kind === "file_activity") { await channel!.consume(raw); return; }
      if (phase === "ready") {
        const ready = parseFileTransferFrame(raw, options.request.requestId, epoch);
        if (ready.kind !== "file_ready" || ready.direction !== "download") throw new ProtocolValidationError("invalid_response", "File download did not begin with readiness");
        options.onReady?.(ready.metadata);
        channel!.configure(ready);
        channel!.receive(options.maximumBytes, options.sink);
        phase = "body";
        return;
      }
      if (phase !== "body") throw new ProtocolValidationError("invalid_response", "Unexpected file frame after completion");
      summary = await channel!.consume(raw);
      if (summary) { phase = "response"; timer = setTimeout(() => finish(new FileResponseError("timeout", "The file result did not arrive. Open the file again.")), options.timeoutMs); }
    };
    let processing = Promise.resolve();
    timer = setTimeout(() => finish(new FileResponseError("timeout", "The file connection timed out. Check the connection and try again.")), options.timeoutMs);
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) { abort(); return; }
    socket.once("connect", () => socket.write(encodeJsonLine(options.hello)));
    socket.on("data", (bytes: Buffer) => {
      wireBytes += bytes.byteLength;
      socket.pause();
      processing = processing.then(async () => { const lines=decoder.push(bytes); channel?.observeWire(bytes.byteLength,decoder.partialRecord); for (const line of lines) await consume(line); })
        .catch(finish).finally(() => { if (!settled) socket.resume(); });
    });
    socket.once("end", () => { ending = true; processing = processing.then(() => { decoder.finish(); if (!terminal) throw new FileResponseError("connection_closed", "The file was not received completely. Open it again."); finish(); }).catch(finish); });
    socket.once("error", (error) => finish(new FileResponseError("connection_error", error.message)));
    socket.once("close", () => { if (!ending) finish(new FileResponseError("connection_closed", "File connection closed. Open the file again.")); else void processing.then(() => { if (!settled) finish(new FileResponseError("connection_closed", "File connection closed. Open the file again.")); }); });
  });
}

/** Old download records are a codec around the common receiver, not a second byte consumer. */
export function receiveLegacyClientFile<M>(options: Omit<ClientFileOptions, "request"> & {
  request: FileTransferRequest;
  sink: (bytes: Uint8Array) => void | Promise<void>;
  frame: (raw: unknown, epoch: string) => { kind: "ready"; metadata: M } | { kind: "chunk"; index: number; data: string } | ({ kind: "complete" } & FileTransferSummary) | { kind: "error"; code: string; message: string };
}): Promise<{ metadata: M; summary: FileTransferSummary }> {
  return new Promise((resolve, reject) => {
    const socket = options.openSocket(), decoder = new JsonLineDecoder();
    const receiver = new FileReceiver({ maximumBytes: options.maximumBytes, chunkBytes: MAX_ATTACHMENT_CHUNK_BYTES, sink: options.sink });
    let epoch: string | undefined, metadata: M | undefined, summary: FileTransferSummary | undefined, settled = false, ending = false;
    let timer: NodeJS.Timeout;
    const abort = () => finish(options.signal?.reason ?? new Error("File read cancelled"));
    const finish = (error?: unknown) => {
      if (settled) return; settled = true; clearTimeout(timer); options.signal?.removeEventListener("abort", abort); socket.destroy();
      if (error) reject(error); else resolve({ metadata: metadata!, summary: summary! });
    };
    const activity = () => { clearTimeout(timer); timer = setTimeout(() => finish(new FileResponseError("timeout", "The file read timed out. Check the connection and try again.")), options.timeoutMs); };
    const consume = async (line: string) => {
      if (!line || settled) return;
      const raw = JSON.parse(line) as unknown;
      if (epoch === undefined) {
        const ack = parseHelloReply(raw, options.hello.requestId);
        epoch = ack.host.hostEpoch; socket.write(encodeJsonLine(options.request)); return;
      }
      if (summary) throw new ProtocolValidationError("invalid_response", "Data after file completion");
      if ((raw as { kind?: string }).kind === "response") {
        const response = parseControlResponse(raw, options.request.requestId, epoch);
        if (!response.ok) throw new FileResponseError(response.error.code, response.error.message, response.error.details);
        throw new ProtocolValidationError("invalid_response", "Legacy file returned ordinary success");
      }
      const frame = options.frame(raw, epoch);
      activity();
      if (frame.kind === "error") throw new FileResponseError(frame.code, frame.message);
      if (frame.kind === "ready") {
        if (metadata !== undefined) throw new ProtocolValidationError("invalid_response", "Repeated file readiness");
        metadata = frame.metadata;
      } else {
        if (metadata === undefined) throw new ProtocolValidationError("invalid_response", "File did not begin with readiness");
        if (frame.kind === "chunk") await receiver.chunk(frame.index, frame.data);
        else summary = receiver.finish(frame);
      }
      activity();
    };
    let processing = Promise.resolve(); activity();
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) { abort(); return; }
    socket.once("connect", () => socket.write(encodeJsonLine(options.hello)));
    socket.on("data", (bytes: Buffer) => { socket.pause(); processing = processing.then(async () => { for (const line of decoder.push(bytes)) await consume(line); }).catch(finish).finally(() => { if (!settled) socket.resume(); }); });
    socket.once("end", () => { ending = true; processing = processing.then(() => { decoder.finish(); if (!summary) throw new FileResponseError("connection_closed", "The file was not received completely. Open it again."); finish(); }).catch(finish); });
    socket.once("error", (error) => finish(new FileResponseError("connection_error", error.message)));
    socket.once("close", () => { if (!ending) finish(new FileResponseError("connection_closed", "File connection closed. Open the file again.")); else void processing.then(() => { if (!settled) finish(new FileResponseError("connection_closed", "File connection closed. Open the file again.")); }); });
  });
}
