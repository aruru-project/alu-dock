import assert from "node:assert/strict";
import test from "node:test";

import { JsonLineDecoder, JsonLineError } from "../src/control/json-lines.js";
import { parseControlRequest, ProtocolValidationError } from "../src/control/protocol.js";

test("JSONL decoder preserves split UTF-8 and treats Unicode separators as data", () => {
  const decoder = new JsonLineDecoder();
  const line = JSON.stringify({ text: "你\u2028好" });
  const encoded = Buffer.from(`${line}\n`, "utf8");
  const split = encoded.indexOf(Buffer.from("你")) + 1;

  assert.deepEqual(decoder.push(encoded.subarray(0, split)), []);
  assert.deepEqual(decoder.push(encoded.subarray(split)), [line]);
  assert.deepEqual(decoder.finish(), []);
});

test("JSONL decoder rejects oversized and unterminated records", () => {
  const oversized = new JsonLineDecoder(4);
  assert.throws(
    () => oversized.push("12345"),
    (error: unknown) => error instanceof JsonLineError && error.code === "record_too_large",
  );

  const incomplete = new JsonLineDecoder();
  incomplete.push('{"ok":true}');
  assert.throws(
    () => incomplete.finish(),
    (error: unknown) => error instanceof JsonLineError && error.code === "incomplete_record",
  );
});

test("control requests reject unknown fields and invalid cursors", () => {
  assert.throws(
    () => parseControlRequest({ version: 1, requestId: "r1", type: "ping", extra: true }),
    ProtocolValidationError,
  );
  assert.throws(
    () => parseControlRequest({
      version: 1,
      requestId: "r2",
      type: "events",
      instanceId: "i1",
      since: -1,
    }),
    ProtocolValidationError,
  );
  assert.throws(
    () => parseControlRequest({
      version: 1,
      requestId: "r3",
      type: "create",
      cwd: "/tmp",
      name: "x".repeat(257),
    }),
    /name must be at most 256 characters/,
  );
});
