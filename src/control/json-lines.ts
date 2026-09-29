import { StringDecoder } from "node:string_decoder";

import { MAX_CONTROL_LINE_BYTES } from "./protocol.js";

export class JsonLineError extends Error {
  constructor(readonly code: "record_too_large" | "incomplete_record", message: string) {
    super(message);
    this.name = "JsonLineError";
  }
}

/** Strict LF-delimited UTF-8 JSONL decoder (U+2028/U+2029 are ordinary data). */
export class JsonLineDecoder {
  private readonly decoder = new StringDecoder("utf8");
  private buffer = "";
  private sequence = 0;
  get partialRecord(): string { return this.buffer; }
  get recordSequence(): number { return this.sequence; }

  constructor(private maxLineBytes = MAX_CONTROL_LINE_BYTES) {}

  /** A negotiated framing may carry longer records than the hello that negotiated it. */
  setMaxLineBytes(maxLineBytes: number): void { this.maxLineBytes = maxLineBytes; }

  push(chunk: Buffer | string): string[] {
    this.buffer += typeof chunk === "string" ? chunk : this.decoder.write(chunk);
    const lines: string[] = [];

    while (true) {
      const newline = this.buffer.indexOf("\n");
      if (newline === -1) break;
      let line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      this.assertLineSize(line);
      lines.push(line);
      this.sequence += 1;
    }

    if (Buffer.byteLength(this.buffer, "utf8") > this.maxLineBytes) {
      throw new JsonLineError("record_too_large", `JSONL record exceeds ${this.maxLineBytes} bytes`);
    }
    return lines;
  }

  finish(): string[] {
    this.buffer += this.decoder.end();
    if (this.buffer.length === 0) return [];
    this.buffer = "";
    throw new JsonLineError("incomplete_record", "JSONL record is missing its LF terminator");
  }

  private assertLineSize(line: string): void {
    if (Buffer.byteLength(line, "utf8") > this.maxLineBytes) {
      throw new JsonLineError("record_too_large", `JSONL record exceeds ${this.maxLineBytes} bytes`);
    }
  }
}

export function encodeJsonLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}
