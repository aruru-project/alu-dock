import type { DockRegistry } from "./dock-registry.js";
import type { FileChannel } from "./file-channel.js";
import { StaleRuntimeGenerationError } from "../core/managed-instance.js";
import { MAX_CONTROL_LINE_BYTES, ProtocolValidationError, type ControlRequest, type ConversationContentStreamResult } from "./protocol.js";

/** Agent pages remain the source. No read reservation is held while waiting for byte credit. */
export async function sendConversationContent(
  request: Extract<ControlRequest, { type: "conversation.content.stream" }>,
  registry: DockRegistry,
  channel: FileChannel,
): Promise<ConversationContentStreamResult> {
  const { instanceId, contentRef } = request.params;
  const instance = registry.get(instanceId);
  let generation: number | undefined;
  const assertCurrent = () => {
    channel.abort.signal.throwIfAborted();
    if (instance.snapshot().lifecycle !== "active") throw new ProtocolValidationError("instance_not_active", "This work is not running. Reopen it and try again.");
    if (generation !== undefined && instance.runtimeGeneration !== generation) throw new StaleRuntimeGenerationError(generation, instance.runtimeGeneration);
  };
  const release = instance.subscribe(() => {
    try { assertCurrent(); } catch (error) { channel.abort.abort(error); }
  });
  try {
    assertCurrent();
    let page = await instance.getConversationContent(contentRef, undefined, "references");
    generation = page.runtimeGeneration;
    assertCurrent();
    const metadata = { contentRef, revision: page.revision, runtimeGeneration: generation };
    const assertPage = () => {
      assertCurrent();
      if (page.instanceId !== instanceId || page.contentRef !== contentRef || page.revision !== metadata.revision || page.runtimeGeneration !== generation) {
        throw new ProtocolValidationError("invalid_response", "Conversation content changed while loading. Open it again.");
      }
    };
    assertPage();
    // Main maps only the terminal root instanceId; ready metadata is deliberately opaque.
    await channel.ready("download", metadata);
    async function* records(): AsyncGenerator<Buffer> {
      const cursors = new Set<string>();
      for (;;) {
        assertPage();
        for (const chunk of page.chunks) {
          assertCurrent();
          const record = Buffer.from(JSON.stringify(chunk) + "\n", "utf8");
          if (record.byteLength - 1 > MAX_CONTROL_LINE_BYTES) throw new ProtocolValidationError("invalid_response", "Conversation record exceeds the protocol record bound");
          yield record;
        }
        if (page.complete) return;
        const cursor = page.nextCursor;
        if (!cursor || cursors.has(cursor)) throw new ProtocolValidationError("invalid_response", "Conversation continuation did not advance");
        cursors.add(cursor);
        assertCurrent();
        page = await instance.getConversationContent(contentRef, cursor, "references");
      }
    }
    const summary = await channel.send({ source: records(), maximumBytes: Number.MAX_SAFE_INTEGER });
    assertCurrent();
    await channel.write({ kind: "file_complete", ...summary });
    assertCurrent();
    return { instanceId, ...metadata, ...summary };
  } finally {
    release();
    channel.dispose();
  }
}
