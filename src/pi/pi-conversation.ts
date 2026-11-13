/**
 * The conversation a Pi-format session hands to the Host: live frames projected from the agent's
 * events, the records of the session's current branch, and the paged history, long content and
 * images read from them. It uses Pi's session entries and events only as types and never loads
 * the Pi agent runtime, so every Worker that keeps its conversation in a Pi-format session
 * shares this one projection.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { mkdir, open } from "node:fs/promises";
import { join } from "node:path";

import type { AgentSessionEvent, SessionEntry } from "@earendil-works/pi-coding-agent";

import { parseOptionalAgentErrorText } from "../control/protocol.js";
import { AgentConversationCursorError } from "../core/agent-worker.js";
import type {
  AgentConversationContentChunk,
  AgentConversationContentPage,
  AgentConversationHistoryPage,
  AgentEvent,
  AgentHistoryEntry,
  ClearedAgentQueue,
} from "../core/agent-worker.js";
import { sliceSemanticHistory, slimSemanticHistoryBlock, slimSemanticHistoryEntry } from "../core/history-pagination.js";
import {
  MAX_BASH_COMMAND_CHARS,
  MAX_CONVERSATION_CHUNK_CHARS,
  MAX_CONVERSATION_CONTENT_BLOCKS,
  MAX_CONVERSATION_CONTENT_PAGE_BYTES,
  MAX_IMAGE_AGGREGATE_BYTES,
  MAX_IMAGE_BYTES,
  MAX_IMAGE_MIME_TYPE_CHARS,
  MAX_IMAGE_PATH_CHARS,
  MAX_INPUT_IMAGES,
  MAX_RECORD_USAGE_TEXT_CHARS,
  MAX_SEMANTIC_HISTORY_PAGE_BYTES,
  MAX_SYSTEM_PROMPT_NAME_CHARS,
  MAX_TEXT_CHARS,
  type AttachmentDto,
  type ContentBlockDto,
  type ConversationFrame,
  type ConversationImageBody,
  type ImagePathDto,
  type PublishedFileDto,
  type RecordUsageDto,
  type SystemPromptBlockDto,
  type SystemPromptChangeDto,
} from "../core/instance-dto.js";
import { projectJsonObject, type JsonValue } from "../core/json-value.js";
import { isPortableAbsoluteLocalPath } from "../core/local-path.js";
import type { NestedToolCallsDto } from "../core/nested-tool-calls.js";
import { projectBuiltInToolPresentation } from "../core/tool-result-presentation.js";
import { hardenWindowsPrivatePath, noFollowFlag } from "../platform/private-state.js";
import { DOCK_ATTACHMENT_RESOLVE_TOOL, redactDockAttachmentToolResult, type DockAttachmentCallPort } from "./dock-attachment-access.js";
import { extractDockAttachmentContext } from "./dock-attachment-context.js";
import { LiveNestedToolCalls, nestedCallArgumentsJson, projectPiNestedToolCalls } from "./pi-nested-tool-calls.js";
import { publishedFileFailureFromDetails, publishedFileFromDetails, redactShowImageResult, SHOW_IMAGE_UNAVAILABLE_MESSAGE } from "./show-image-result.js";
import type { TransientFileRegistry } from "./transient-file-registry.js";

/** The conversation being read: the session's identity and its current branch. */
export interface PiConversationSource {
  getSessionId(): string;
  getLeafId(): string | null;
  getLeafEntry(): SessionEntry | undefined;
  getBranch(): SessionEntry[];
}

interface ConversationReadEntry {
  source: SessionEntry;
  semantic: Parameters<typeof sliceSemanticHistory>[0][number];
  contentRef: string;
}
interface ConversationReadState {
  revision: string;
  sessionId: string;
  leafId: string | null;
  entries: ConversationReadEntry[];
  byRef: Map<string, ConversationReadEntry>;
  /** Earlier entries on the branch, so a context edit can be shown the way its target is. */
  byEntryId: Map<string, SessionEntry>;
  imageSources: Map<string, object>;
  previews: Map<SessionEntry, { projected: AgentHistoryEntry; bytes: number }>;
  previewBytes: number;
  reading?: { item: ConversationReadEntry; blocks: ConversationSourceBlock[] };
}

/**
 * Reads the current branch of Pi-format sessions the way the Host is given it. What was read of
 * a session is kept with that session object: entries appended to the same branch keep its
 * revision and every continuation handed out. A session read for the first time, another
 * branch, or `invalidate` starts a new revision and ends all continuations of this reader.
 */
export class PiSessionConversation {
  private conversationScope = randomUUID();
  private states = new WeakMap<PiConversationSource, ConversationReadState>();
  private readonly conversationHistoryCursors = new Map<string, { revision: string; end: number; view?: "references" }>();
  private readonly conversationContentCursors = new Map<string, { revision: string; contentRef: string; blockIndex: number; offset: number; view?: "references" }>();

  constructor(private readonly options: { attachmentContextKey: Uint8Array; publishedFiles: TransientFileRegistry }) {}

  /** Every record of the current branch, as the Host's checkpoint and `session.history` carry them. */
  entries(session: PiConversationSource): AgentHistoryEntry[] {
    const state = this.conversationState(session);
    return state.entries.map(({ source }) => this.conversationProjection(state, source));
  }

  async history(session: PiConversationSource, cursor?: string, limit = 50, view?: "references"): Promise<AgentConversationHistoryPage> {
    const state = this.conversationState(session);
    const boundedLimit = Math.max(1, Math.min(200, Math.floor(limit)));
    let end = state.entries.length;
    if (cursor !== undefined) {
      const continuation = this.conversationHistoryCursors.get(cursor);
      if (!continuation || continuation.revision !== state.revision || continuation.view !== view) throw new AgentConversationCursorError("Conversation history cursor is stale");
      end = continuation.end;
    }
    // A continuation reads its accepted prefix, not tool results appended after
    // that page boundary (which could otherwise move an old semantic range).
    const page = sliceSemanticHistory(state.entries.slice(0, end).map(({ semantic }) => semantic), end, boundedLimit);
    const selected = state.entries.slice(page.start, page.end);
    let entries = selected.map((item) => {
      const projected = this.conversationProjection(state, item.source);
      const entry = previewConversationEntry(projected);
      const blocks = conversationContentBlocks(item.source, projected, this.options.attachmentContextKey, this.options.publishedFiles, state.byEntryId);
      return {
        entry, contentRef: item.contentRef,
        contentComplete: conversationPreviewIsComplete(blocks, entry, view),
        totalBlocks: blocks.length,
      };
    });
    const nextCursor = page.hasEarlier ? randomUUID() : undefined;
    const result = (): AgentConversationHistoryPage => ({
      revision: state.revision,
      entries,
      hasEarlier: page.hasEarlier,
      ...(nextCursor === undefined ? {} : { nextCursor }),
    });
    if (Buffer.byteLength(JSON.stringify(result()), "utf8") > MAX_SEMANTIC_HISTORY_PAGE_BYTES) {
      entries = entries.map((item, index) => {
        const entry = slimSemanticHistoryEntry(item.entry);
        return { ...item, entry, contentComplete: item.contentComplete && conversationPreviewIsComplete(
          conversationContentBlocks(selected[index]!.source, this.conversationProjection(state, selected[index]!.source), this.options.attachmentContextKey, this.options.publishedFiles, state.byEntryId), entry, view,
        ) };
      });
    }
    const bounded = result();
    if (Buffer.byteLength(JSON.stringify(bounded), "utf8") > MAX_SEMANTIC_HISTORY_PAGE_BYTES) {
      throw new Error("A complete conversation section is too large to return in one history page");
    }
    if (nextCursor !== undefined) {
      this.conversationHistoryCursors.set(nextCursor, { revision: state.revision, end: page.start, view });
      trimTokenMap(this.conversationHistoryCursors);
    }
    return bounded;
  }

  image(session: PiConversationSource, contentRef: string): ConversationImageBody {
    const image = this.options.publishedFiles.image(contentRef)
      ?? this.options.publishedFiles.image(contentRef, this.conversationState(session).imageSources.get(contentRef));
    if (image === undefined) throw new AgentConversationCursorError("Conversation image reference is stale");
    return image;
  }

  async content(session: PiConversationSource, contentRef: string, cursor?: string, view?: "references"): Promise<AgentConversationContentPage> {
    const nativeImage = view === undefined ? this.options.publishedFiles.readImageContent(contentRef, cursor) : undefined;
    if (nativeImage !== undefined) return nativeImage;
    const state = this.conversationState(session);
    const image = this.options.publishedFiles.image(contentRef, state.imageSources.get(contentRef));
    if (image !== undefined) {
      if (view === "references") {
        if (cursor !== undefined) throw new AgentConversationCursorError("Conversation image reference view has no continuation");
        return { revision: contentRef, contentRef, complete: true, chunks: [
          { type: "image_ref", blockIndex: 0, mimeType: image.mimeType, contentRef: image.contentRef },
        ] };
      }
      const restored = this.options.publishedFiles.readImageContent(contentRef, cursor);
      if (restored !== undefined) return restored;
    }
    let blockIndex = 0;
    let offset = 0;
    if (cursor !== undefined) {
      const continuation = this.conversationContentCursors.get(cursor);
      if (!continuation || continuation.revision !== state.revision || continuation.contentRef !== contentRef || continuation.view !== view) {
        throw new AgentConversationCursorError("Conversation content cursor is stale");
      }
      blockIndex = continuation.blockIndex;
      offset = continuation.offset;
    }
    const selected = state.byRef.get(contentRef);
    if (!selected) throw new AgentConversationCursorError("Conversation content reference is stale");
    // Keep only the most recently read record's full block view. Persisted
    // previews are cached, but full joined text/argument JSON is not duplicated
    // for the whole session or for every continuation token.
    if (state.reading?.item !== selected) state.reading = {
      item: selected, blocks: conversationContentBlocks(selected.source, this.conversationProjection(state, selected.source), this.options.attachmentContextKey, this.options.publishedFiles, state.byEntryId),
    };
    const blocks = state.reading.blocks;
    const chunks: AgentConversationContentChunk[] = [];
    let chars = 0;
    while (blockIndex < blocks.length && chunks.length < 64 && chars < 64_000) {
      const block = blocks[blockIndex]!;
      if (block.type === "text" || block.type === "thinking") {
        const remaining = Math.max(1, 64_000 - chars);
        const end = unicodeSafeEnd(block.text, Math.min(block.text.length, offset + Math.min(MAX_CONVERSATION_CHUNK_CHARS, remaining)));
        const text = block.text.slice(offset, end);
        const blockComplete = end >= block.text.length;
        chunks.push({ blockIndex, type: block.type, text, offset, blockComplete });
        chars += text.length;
        if (blockComplete) { blockIndex += 1; offset = 0; } else { offset = end; break; }
      } else if (block.type === "image") {
        if (view === "references") {
          const { data: _data, type: _type, ...reference } = block;
          chunks.push({ ...reference, type: "image_ref", blockIndex });
          blockIndex += 1;
          offset = 0;
          continue;
        }
        const remaining = Math.max(1, 64_000 - chars);
        const end = unicodeSafeEnd(block.data, Math.min(block.data.length, offset + Math.min(MAX_CONVERSATION_CHUNK_CHARS, remaining)));
        const data = block.data.slice(offset, end);
        const blockComplete = end >= block.data.length;
        chunks.push({ type: "image", mimeType: block.mimeType, blockIndex, data, offset, blockComplete });
        chars += data.length;
        if (blockComplete) { blockIndex += 1; offset = 0; } else { offset = end; break; }
      } else if (block.type === "tool_call") {
        const remaining = Math.max(1, 64_000 - chars);
        const end = unicodeSafeEnd(block.argumentsJson, Math.min(block.argumentsJson.length, offset + Math.min(MAX_CONVERSATION_CHUNK_CHARS, remaining)));
        const argumentsJson = block.argumentsJson.slice(offset, end);
        const blockComplete = end >= block.argumentsJson.length;
        chunks.push({ ...block, blockIndex, argumentsJson, offset, blockComplete });
        chars += argumentsJson.length;
        if (blockComplete) { blockIndex += 1; offset = 0; } else { offset = end; break; }
      } else if (block.type === "tool_result") {
        const { nestedCalls, ...identity } = block;
        const remaining = Math.max(1, 64_000 - chars);
        const end = unicodeSafeEnd(block.text, Math.min(block.text.length, offset + Math.min(MAX_CONVERSATION_CHUNK_CHARS, remaining)));
        const text = block.text.slice(offset, end);
        let chunk: Extract<AgentConversationContentChunk, { type: "tool_result" }> = { ...identity, blockIndex, text, offset, blockComplete: end >= block.text.length };
        if (chunk.blockComplete && nestedCalls !== undefined) {
          // The calls arrive once, with the chunk that completes the result. A page that cannot
          // also hold them ends before it, or carries the text alone and leaves them for the next.
          const withCalls = { ...chunk, nestedCalls };
          if (contentPageFits(state.revision, contentRef, [...chunks, withCalls])) chunk = withCalls;
          else if (chunks.length > 0) break;
          else if (text.length > 0) chunk = { ...chunk, blockComplete: false };
          // Otherwise the calls alone exceed a page: the result still completes, without them.
        }
        chunks.push(chunk);
        chars += text.length;
        if (chunk.blockComplete) { blockIndex += 1; offset = 0; } else { offset = end; break; }
      } else {
        chunks.push({ ...block, blockIndex } as AgentConversationContentChunk);
        blockIndex += 1;
        offset = 0;
      }
    }
    if (blockIndex >= blocks.length) return { revision: state.revision, contentRef, chunks, complete: true };
    const nextCursor = randomUUID();
    this.conversationContentCursors.set(nextCursor, { revision: state.revision, contentRef, blockIndex, offset, view });
    trimTokenMap(this.conversationContentCursors);
    return { revision: state.revision, contentRef, chunks, complete: false, nextCursor };
  }

  /** The runtime the sessions belong to was replaced: no earlier revision or continuation stays valid. */
  invalidate(): void {
    this.conversationScope = randomUUID();
    this.conversationHistoryCursors.clear();
    this.conversationContentCursors.clear();
    this.states = new WeakMap();
  }

  private conversationProjection(state: ConversationReadState, source: SessionEntry): AgentHistoryEntry {
    const cached = state.previews.get(source);
    if (cached) {
      state.previews.delete(source);
      state.previews.set(source, cached);
      return cached.projected;
    }
    const projected = projectHistoryEntry(source, this.options.attachmentContextKey, this.options.publishedFiles, state.byEntryId);
    const bytes = Buffer.byteLength(JSON.stringify(projected), "utf8");
    // One existing producer page budget for hot previews, not a second transcript.
    if (bytes <= MAX_SEMANTIC_HISTORY_PAGE_BYTES) {
      while (state.previewBytes + bytes > MAX_SEMANTIC_HISTORY_PAGE_BYTES) {
        const oldest = state.previews.keys().next().value!;
        state.previewBytes -= state.previews.get(oldest)!.bytes;
        state.previews.delete(oldest);
      }
      state.previews.set(source, { projected, bytes });
      state.previewBytes += bytes;
    }
    return projected;
  }

  private conversationState(session: PiConversationSource): ConversationReadState {
    const sessionId = session.getSessionId();
    const leafId = session.getLeafId();
    const previous = this.states.get(session);
    // Pi's public SessionManager is append-only. Unchanged leaf object identity
    // avoids walking/projecting/hashing the branch for each content chunk.
    if (previous?.sessionId === sessionId && previous.leafId === leafId
      && previous.entries.at(-1)?.source === session.getLeafEntry()) return previous;
    const branch = session.getBranch();
    const appended = previous?.sessionId === sessionId
      && previous.entries.length <= branch.length
      && previous.entries.every((item, index) => item.source === branch[index]);
    const state: ConversationReadState = appended ? previous : {
      revision: createHash("sha256").update(this.conversationScope).update(randomUUID()).digest("hex"),
      sessionId, leafId, entries: [], byRef: new Map(), byEntryId: new Map(), imageSources: new Map(), previews: new Map(), previewBytes: 0,
    };
    if (!appended) {
      this.conversationHistoryCursors.clear();
      this.conversationContentCursors.clear();
    }
    // Retain just the current authoritative branch, not a snapshot per scan.
    // The revision and old page end positions survive verified prefix append;
    // a different branch/session/scope starts a new read domain for old clients too.
    for (const source of branch.slice(state.entries.length)) {
      const projected = this.conversationProjection(state, source);
      const content = source.type === "message" ? (source.message as unknown as Record<string, unknown>).content
        : source.type === "custom_message" ? source.content : undefined;
      if (Array.isArray(content)) for (const block of content) {
        if (!isRecord(block) || block.type !== "image") continue;
        const imageRef = this.options.publishedFiles.imageReference(block)
          ?? registerConversationImage(this.options.publishedFiles, typeof block.data === "string" ? block.data : undefined, safeImageMimeType(block.mimeType), block)?.contentRef;
        if (imageRef !== undefined) state.imageSources.set(imageRef, block);
      }
      const item: ConversationReadEntry = {
        source,
        semantic: {
          source: projected.source,
          content: projected.content.flatMap((block) => block.type === "tool_call" || block.type === "tool_result"
            ? [{ type: block.type, toolCallId: block.toolCallId }] : []),
        },
        contentRef: conversationContentRef(sessionId, source.id),
      };
      state.entries.push(item);
      state.byRef.set(item.contentRef, item);
      state.byEntryId.set(source.id, source);
    }
    state.leafId = leafId;
    this.states.set(session, state);
    return state;
  }
}

export function boundedString(value: unknown, limit: number, fallback: string): string {
  if (typeof value !== "string" || value.length === 0) return fallback;
  if (value.length <= limit) return value;
  const requestedEnd = Math.max(0, limit - 1);
  const end = requestedEnd > 0
    && /[\uD800-\uDBFF]/u.test(value[requestedEnd - 1] ?? "")
    && /[\uDC00-\uDFFF]/u.test(value[requestedEnd] ?? "")
    ? requestedEnd - 1
    : requestedEnd;
  return `${value.slice(0, end)}…`;
}

function boundedContentString(value: unknown, limit: number): string {
  if (typeof value !== "string" || value.length === 0) return "";
  if (value.length <= limit) return value;
  return value.slice(0, unicodeSafeEnd(value, limit));
}

function optionalContentString(value: unknown, limit: number): string | undefined {
  const content = boundedContentString(value, limit);
  return content.length > 0 ? content : undefined;
}

export interface PiImageContent { type: "image"; data: string; mimeType: string }

export async function resolveAttachmentImages(
  attachments: readonly AttachmentDto[] | undefined,
  port: DockAttachmentCallPort | undefined,
): Promise<ImagePathDto[] | undefined> {
  const images = (attachments ?? []).filter((attachment) => safeImageMimeType(attachment.mediaType) === attachment.mediaType);
  if (images.length === 0) return undefined;
  if (!port) throw new Error("This image attachment can’t be opened right now. Re-upload it and try again.");
  return Promise.all(images.map(async (attachment) => {
    const resolved = await port.access({ type: "resolve", fileId: attachment.fileId });
    if (resolved.type !== "resolve" || resolved.attachment.fileId !== attachment.fileId) {
      throw new Error(`The image attachment ${attachment.name} is no longer available. Re-upload it and try again.`);
    }
    return { path: resolved.path, mimeType: attachment.mediaType! };
  }));
}

function safeImageMimeType(value: unknown): string {
  return typeof value === "string"
    && value.length <= MAX_IMAGE_MIME_TYPE_CHARS
    && /^image\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*$/u.test(value)
    ? value
    : "image/unknown";
}

function imageBase64Metadata(data: string): { sha256: string; sizeBytes: number } | undefined {
  if (data.length === 0 || data.length > Math.ceil(MAX_IMAGE_BYTES * 4 / 3) + 4) return undefined;
  try {
    const bytes = Buffer.from(data, "base64");
    if (bytes.toString("base64") !== data || bytes.byteLength > MAX_IMAGE_BYTES) return undefined;
    return { sha256: createHash("sha256").update(bytes).digest("hex"), sizeBytes: bytes.byteLength };
  } catch { return undefined; }
}

function registerConversationImage(publishedFiles: TransientFileRegistry | undefined, data: string | undefined, mimeType: string, source?: object): { contentRef: string; sha256: string; sizeBytes: number } | undefined {
  if (publishedFiles === undefined || data === undefined) return undefined;
  try { return publishedFiles.registerImage(data, mimeType, source); }
  catch { return undefined; }
}

export async function loadPiImages(images: readonly ImagePathDto[] | undefined): Promise<PiImageContent[] | undefined> {
  if (images === undefined || images.length === 0) return undefined;
  if (!Array.isArray(images) || images.length > MAX_INPUT_IMAGES) throw new Error(`Image input exceeds ${MAX_INPUT_IMAGES} files`);
  const opened: Array<{ handle: Awaited<ReturnType<typeof open>>; mimeType: string; size: number }> = [];
  let aggregate = 0;
  try {
    const seen = new Set<string>();
    for (const [index, image] of images.entries()) {
      const imageNumber = index + 1;
      if (!image || typeof image.path !== "string" || image.path.length < 1 || image.path.length > MAX_IMAGE_PATH_CHARS || !isPortableAbsoluteLocalPath(image.path) || /[\u0000-\u001f\u007f-\u009f]/u.test(image.path)) throw new Error(`Image ${imageNumber} path must be a bounded absolute local path`);
      const mimeType = safeImageMimeType(image.mimeType);
      if (mimeType !== image.mimeType) throw new Error(`Image ${imageNumber} MIME type must be a bounded image/* value`);
      const descriptorKey = `${image.path}\u0000${mimeType}`;
      if (seen.has(descriptorKey)) throw new Error("Image descriptors must be unique");
      seen.add(descriptorKey);
      let handle: Awaited<ReturnType<typeof open>>;
      try { handle = await open(image.path, "r"); }
      catch { throw new Error(`Image ${imageNumber} could not be opened`); }
      try {
        const stat = await handle.stat();
        if (!stat.isFile()) throw new Error(`Image ${imageNumber} path is not a regular file`);
        if (stat.size > MAX_IMAGE_BYTES) throw new Error(`Image ${imageNumber} exceeds ${MAX_IMAGE_BYTES} bytes`);
        aggregate += stat.size;
        if (aggregate > MAX_IMAGE_AGGREGATE_BYTES) throw new Error(`Image input exceeds ${MAX_IMAGE_AGGREGATE_BYTES} aggregate bytes`);
        opened.push({ handle, mimeType, size: stat.size });
      } catch (error) {
        await handle.close().catch(() => {});
        throw error;
      }
    }
    const result: PiImageContent[] = [];
    for (const [index, image] of opened.entries()) {
      const bytes = Buffer.allocUnsafe(image.size);
      let offset = 0;
      try {
        while (offset < bytes.length) {
          const read = await image.handle.read(bytes, offset, bytes.length - offset, offset);
          if (read.bytesRead === 0) break;
          offset += read.bytesRead;
        }
        const extra = Buffer.allocUnsafe(1);
        const extraRead = await image.handle.read(extra, 0, 1, offset);
        if (extraRead.bytesRead > 0) throw new Error("changed");
      } catch {
        throw new Error(`Image ${index + 1} could not be read as a stable file`);
      }
      result.push({ type: "image", data: bytes.subarray(0, offset).toString("base64"), mimeType: image.mimeType });
    }
    return result;
  } finally {
    await Promise.all(opened.map(({ handle }) => handle.close().catch(() => {})));
  }
}

export function safeOptionalText(value: unknown, limit: number): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  return boundedString(value, limit, "");
}

export function safeRequiredText(value: unknown, limit: number, fallback: string): string {
  return safeOptionalText(value, limit) ?? fallback;
}

export function projectAgentSessionEvents(event: AgentSessionEvent, publishedFiles?: TransientFileRegistry): AgentEvent[] {
  const source = event as unknown as Record<string, unknown>;
  if (source.type === "message_update" && isRecord(source.assistantMessageEvent)) {
    const update = source.assistantMessageEvent;
    if ((update.type === "text_delta" || update.type === "thinking_delta") && typeof update.delta === "string" && update.delta.length > MAX_TEXT_CHARS) {
      const projected: AgentEvent[] = [];
      let offset = 0;
      while (offset < update.delta.length) {
        const end = unicodeSafeEnd(update.delta, Math.min(update.delta.length, offset + MAX_TEXT_CHARS));
        projected.push(projectAgentSessionEvent({ ...source, assistantMessageEvent: { ...update, delta: update.delta.slice(offset, end) } }, publishedFiles));
        offset = end;
      }
      return projected;
    }
  }
  if (source.type === "entry_appended") return [{ type: "conversation_checkpoint" }];
  const projected = projectAgentSessionEvent(source, publishedFiles);
  if (source.type === "turn_end" || source.type === "agent_settled" || source.type === "compaction_end") {
    return [projected, { type: "conversation_checkpoint" }];
  }
  return [projected];
}

function projectAgentSessionEvent(event: AgentSessionEvent | Record<string, unknown>, publishedFiles?: TransientFileRegistry): AgentEvent {
  const source = event as unknown as Record<string, unknown>;
  const type = typeof source.type === "string" ? source.type : "unknown";
  if (type === "agent_end") return { type, willRetry: source.willRetry === true };
  if (type === "turn_end" || type === "entry_appended") return { type };
  if ((type === "message_start" || type === "message_end") && isRecord(source.message)) {
    return { type, message: projectRuntimeMessage(source.message, publishedFiles) };
  }
  if (type === "message_update" && isRecord(source.assistantMessageEvent)) {
    return { type, assistantMessageEvent: projectAssistantMessageEvent(source.assistantMessageEvent) };
  }
  // Calls a tool made itself (for example from a codemode script) name the call that made them.
  const parent = typeof source.parentToolCallId === "string" ? { parentToolCallId: safeRequiredText(source.parentToolCallId, 128, "unknown") } : {};
  if (type === "tool_execution_start" && "parentToolCallId" in parent) {
    // Shown only inside the caller: the arguments follow Pi's record, not Dock's model-call bounds.
    const argumentsJson = nestedCallArgumentsJson(source.args);
    return {
      type,
      toolCallId: safeRequiredText(source.toolCallId, 128, "unknown"),
      toolName: safeRequiredText(source.toolName, 256, "tool"),
      ...(argumentsJson === undefined ? {} : { argumentsJson }),
      ...parent,
    };
  }
  if (type === "tool_execution_start") {
    return {
      type,
      toolCallId: safeRequiredText(source.toolCallId, 128, "unknown"),
      toolName: safeRequiredText(source.toolName, 256, "tool"),
      args: projectJsonObject(source.args).value,
    };
  }
  if (type === "tool_execution_end" || type === "tool_execution_update") {
    const resultKey = type === "tool_execution_end" ? "result" : "partialResult";
    const result = isRecord(source[resultKey]) ? source[resultKey] as Record<string, unknown> : undefined;
    const toolName = typeof source.toolName === "string" ? source.toolName : undefined;
    const isError = type === "tool_execution_end" && source.isError === true;
    const contentText = optionalContentString(toolResultText(result?.content), 256_000);
    const content = projectPrivateToolContent(result?.content, publishedFiles);
    const publishedFile = publishedFiles === undefined ? undefined : publishedFileFromDetails(result?.details, publishedFiles);
    const showImageError = publishedFiles === undefined ? undefined : publishedFileFailureFromDetails(result?.details, publishedFiles);
    const presentation = projectBuiltInToolPresentation(toolName, contentText, result?.details, isError);
    return {
      type,
      toolCallId: safeRequiredText(source.toolCallId, 128, "unknown"),
      toolName: safeRequiredText(source.toolName, 256, "tool"),
      [resultKey]: { content, ...(publishedFile === undefined ? {} : { publishedFile }), ...(showImageError === undefined ? {} : { showImageError }), ...(presentation === undefined ? {} : { presentation }) },
      ...(type === "tool_execution_end" ? { isError } : {}),
      ...parent,
    };
  }
  if (type === "compaction_end") {
    return {
      type,
      reason: source.reason,
      aborted: source.aborted === true,
      willRetry: source.willRetry === true,
      ...(source.errorMessage === undefined ? {} : { errorMessage: parseOptionalAgentErrorText(source.errorMessage) }),
    };
  }
  return source as AgentEvent;
}

function projectRuntimeMessage(message: Record<string, unknown>, publishedFiles?: TransientFileRegistry): Record<string, unknown> {
  const role = safeRequiredText(message.role, 64, "system");
  const projected: Record<string, unknown> = {
    role,
    content: role === "toolResult" ? projectPrivateToolContent(message.content, publishedFiles) : projectPrivateContent(message.content, publishedFiles, role === "user"),
  };
  const stopReason = safeOptionalText(message.stopReason, 128);
  const errorMessage = parseOptionalAgentErrorText(message.errorMessage);
  const toolCallId = safeOptionalText(message.toolCallId, 128);
  if (stopReason !== undefined) projected.stopReason = stopReason;
  if (errorMessage !== undefined) projected.errorMessage = errorMessage;
  if (toolCallId !== undefined) projected.toolCallId = toolCallId;
  return projected;
}

function projectAssistantMessageEvent(update: Record<string, unknown>): Record<string, unknown> {
  const type = safeRequiredText(update.type, 64, "unknown");
  const projected: Record<string, unknown> = { type };
  if (typeof update.contentIndex === "number" && Number.isSafeInteger(update.contentIndex) && update.contentIndex >= 0) projected.contentIndex = update.contentIndex;
  const delta = safeOptionalText(update.delta, MAX_TEXT_CHARS);
  if (delta !== undefined) projected.delta = delta;
  if (isRecord(update.partial)) projected.partial = { content: projectPrivateContent(update.partial.content) };
  if (isRecord(update.toolCall)) projected.toolCall = projectPrivateToolCall(update.toolCall);
  return projected;
}

function projectPrivateContent(content: unknown, publishedFiles?: TransientFileRegistry, user = false): unknown {
  // Authentication must run before public text clipping, including for long user
  // messages whose signed attachment context is at the end. This stays in Worker.
  if (typeof content === "string") return user ? content : boundedContentString(content, 256_000);
  if (!Array.isArray(content)) return [];
  const blocks: Record<string, unknown>[] = [];
  for (const item of content.slice(0, MAX_CONVERSATION_CONTENT_BLOCKS)) {
    if (!isRecord(item)) continue;
    if (item.type === "text" && typeof item.text === "string" && item.text.length > 0) {
      blocks.push({ type: "text", text: user ? item.text : boundedContentString(item.text, MAX_TEXT_CHARS) });
    } else if (item.type === "thinking") {
      const thinking = optionalContentString(item.thinking, MAX_TEXT_CHARS);
      if (thinking !== undefined) blocks.push({ type: "thinking", thinking });
    }
    else if (item.type === "toolCall" || item.type === "tool_call") blocks.push(projectPrivateToolCall(item));
    else if (item.type === "image") {
      const mimeType = safeImageMimeType(item.mimeType);
      const imageData = typeof item.data === "string" ? item.data : undefined;
      const image = registerConversationImage(publishedFiles, imageData, mimeType, item);
      blocks.push({
        type: "image",
        mimeType,
        ...(image === undefined ? {} : { contentRef: image.contentRef, sha256: image.sha256 }),
      });
    }
  }
  return blocks;
}

function projectPrivateToolContent(content: unknown, publishedFiles?: TransientFileRegistry): unknown {
  if (typeof content === "string") return boundedContentString(content, 256_000);
  if (!Array.isArray(content)) return [];
  return content.slice(0, MAX_CONVERSATION_CONTENT_BLOCKS).flatMap((item): Record<string, unknown>[] => {
    if (!isRecord(item)) return [];
    if (item.type === "text" && typeof item.text === "string") return [{ type: "text", text: boundedContentString(item.text, 256_000) }];
    if (item.type === "image") {
      const mimeType = safeImageMimeType(item.mimeType);
      const image = registerConversationImage(publishedFiles, typeof item.data === "string" ? item.data : undefined, mimeType, item);
      return [{ type: "image", mimeType, ...(image === undefined ? {} : { contentRef: image.contentRef }) }];
    }
    return [];
  });
}

function projectPrivateToolCall(value: Record<string, unknown>): Record<string, unknown> {
  return {
    type: "toolCall",
    id: safeRequiredText(value.id, 128, "unknown"),
    name: safeRequiredText(value.name, 256, "tool"),
    arguments: projectJsonObject(value.arguments).value,
  };
}

function toolResultText(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const parts: string[] = [];
  for (const item of content) {
    if (!isRecord(item) || item.type !== "text" || typeof item.text !== "string") continue;
    parts.push(item.text);
  }
  return parts.length > 0 ? parts.join("") : undefined;
}

export interface PiConversationInput {
  operationId: string;
  text: string;
  runtimeText?: string;
  consumedText?: string;
  delivery: "prompt" | "steer" | "followUp";
  fromQueue: boolean;
  images?: ImagePathDto[];
  attachments?: AttachmentDto[];
}

function piInputConsumedText(input: PiConversationInput): string {
  return input.consumedText ?? input.runtimeText ?? input.text;
}

/** Pi keeps the handed-over text intact and only appends its own notes after a blank line. */
function piStoredTextMatches(stored: string, handedOver: string): boolean {
  return stored === handedOver || stored.startsWith(`${handedOver}\n\n`);
}

export class PiConversationProjector {
  private readonly inputs: PiConversationInput[] = [];
  private steeringQueue: string[] = [];
  private followUpQueue: string[] = [];

  constructor(private readonly attachmentContextKey: Uint8Array) {}
  private readonly announcedToolCalls = new Set<string>();
  private readonly completedToolCalls = new Set<string>();
  private readonly nestedCalls = new LiveNestedToolCalls();
  /** Latest output of each running tool, repeated when only its nested calls change. */
  private readonly toolOutputs = new Map<string, Extract<ConversationFrame, { type: "tool.output_updated" }>["data"]>();
  private messageSequence = 0;
  private currentUserMessageId: string | undefined;
  private currentUserAttachments: AttachmentDto[] | undefined;
  private currentAssistantMessageId: string | undefined;
  private lastAssistantOutcome: { stopReason?: string; error?: string } | undefined;

  trackInput(input: PiConversationInput): PiConversationInput {
    const tracked = structuredClone(input);
    this.inputs.push(tracked);
    return tracked;
  }

  cancelInput(input: PiConversationInput): void {
    const index = this.inputs.indexOf(input);
    if (index >= 0) this.inputs.splice(index, 1);
  }

  nextInputOperationId(): string | undefined {
    return this.inputs[0]?.operationId;
  }

  clearQueuedInputs(cleared: ClearedAgentQueue): void {
    const remove = (delivery: "steer" | "followUp", texts: readonly string[]): void => {
      for (const text of texts) {
        const index = this.inputs.findIndex((input) => input.delivery === delivery && piInputConsumedText(input) === text);
        if (index >= 0) this.inputs.splice(index, 1);
      }
    };
    remove("steer", cleared.steering);
    remove("followUp", cleared.followUp);
  }

  observeQueueUpdate(steering: readonly string[], followUp: readonly string[]): void {
    // Pi publishes this after input hooks and template/skill expansion, before a queued message can start.
    // Capture that public queue text once so later consumption keeps the Dock operation identity.
    this.captureQueuedInputs("steer", this.steeringQueue, steering);
    this.captureQueuedInputs("followUp", this.followUpQueue, followUp);
    this.steeringQueue = [...steering];
    this.followUpQueue = [...followUp];
  }

  private captureQueuedInputs(
    delivery: "steer" | "followUp",
    previous: readonly string[],
    current: readonly string[],
  ): void {
    if (current.length <= previous.length) return;
    for (const consumedText of current.slice(previous.length)) {
      const input = this.inputs.find((candidate) => candidate.delivery === delivery && candidate.consumedText === undefined);
      if (input !== undefined) input.consumedText = consumedText;
    }
  }

  project(event: AgentEvent): AgentEvent[] {
    if (event.type === "agent_start") {
      this.currentUserMessageId = undefined;
      this.currentUserAttachments = undefined;
      this.currentAssistantMessageId = undefined;
      this.announcedToolCalls.clear();
      this.completedToolCalls.clear();
      this.nestedCalls.clear();
      this.toolOutputs.clear();
      this.lastAssistantOutcome = undefined;
      return [event];
    }
    if (event.type === "agent_settled") {
      const outcome = this.lastAssistantOutcome;
      this.lastAssistantOutcome = undefined;
      return [{
        type: "agent_settled",
        ...(typeof event.operationId === "string" ? { operationId: event.operationId } : {}),
        // Pi marks a stopped run on agent_settled. One stopped before its first request
        // ends with an error reply ("This operation was aborted"), which is not a failure.
        ...(event.aborted === true
          ? { stopReason: "aborted" }
          : {
            ...(outcome?.stopReason === undefined ? {} : { stopReason: outcome.stopReason }),
            ...(outcome?.error === undefined ? {} : { error: outcome.error }),
          }),
      }];
    }
    if (event.type === "message_start") return this.projectMessageStart(event);
    if (event.type === "message_update") return this.projectMessageUpdate(event);
    if (event.type === "message_end") return this.projectMessageEnd(event);
    if (event.type === "tool_execution_start") return this.projectToolStart(event);
    if (event.type === "tool_execution_update") return this.projectToolUpdate(event);
    if (event.type === "tool_execution_end") return this.projectToolEnd(event);
    return [event];
  }

  private projectMessageStart(event: AgentEvent): AgentEvent[] {
    const message = isRecord(event.message) ? event.message : undefined;
    if (message?.role !== "user") {
      if (message?.role === "assistant") this.ensureAssistantMessageId();
      return [];
    }
    const consumedText = toolResultText(message.content) ?? "";
    const extracted = extractDockAttachmentContext(consumedText, this.attachmentContextKey);
    // An exact match wins; otherwise accept the same text with Pi's notes appended.
    let inputIndex = this.inputs.findIndex((candidate) => piInputConsumedText(candidate) === consumedText || candidate.text === extracted.text);
    if (inputIndex < 0) {
      inputIndex = this.inputs.findIndex((candidate) => piStoredTextMatches(consumedText, piInputConsumedText(candidate)) || piStoredTextMatches(extracted.text, candidate.text));
    }
    const input = inputIndex < 0 ? undefined : this.inputs.splice(inputIndex, 1)[0];
    const operationId = input?.operationId ?? "runtime-initiated";
    this.currentUserMessageId = input === undefined
      ? `user-runtime-${++this.messageSequence}`
      : `user-${input.operationId}`;
    this.currentUserAttachments = structuredClone(input?.attachments ?? extracted.attachments);
    const data = {
      operationId,
      messageId: this.currentUserMessageId,
      role: "user" as const,
      text: boundedContentString(input?.text || extracted.text, 256_000),
      ...(input?.images === undefined ? {} : { images: structuredClone(input.images) }),
      ...(this.currentUserAttachments === undefined ? {} : { attachments: structuredClone(this.currentUserAttachments) }),
      delivery: input?.delivery ?? "prompt",
    };
    return [
      ...(input?.fromQueue === true ? [{ type: "dock_queue_consumed", operationId: input.operationId }] : []),
      this.frame({ type: "message.submitted", data }),
    ];
  }

  private projectMessageUpdate(event: AgentEvent): AgentEvent[] {
    const update = isRecord(event.assistantMessageEvent) ? event.assistantMessageEvent : undefined;
    if (!update) return [];
    if (update.type === "start") {
      this.ensureAssistantMessageId();
      return [];
    }
    if ((update.type === "text_delta" || update.type === "thinking_delta") && typeof update.delta === "string" && update.delta.length > 0) {
      return [this.frame({
        type: "message.delta",
        data: {
          messageId: this.ensureAssistantMessageId(),
          block: update.type === "text_delta" ? "text" : "thinking",
          delta: boundedContentString(update.delta, MAX_TEXT_CHARS),
        },
      })];
    }
    if (update.type !== "toolcall_start" && update.type !== "toolcall_delta" && update.type !== "toolcall_end") return [];
    this.ensureAssistantMessageId();
    const index = typeof update.contentIndex === "number" && Number.isSafeInteger(update.contentIndex) && update.contentIndex >= 0
      ? update.contentIndex
      : 0;
    const partial = isRecord(update.partial) ? update.partial : undefined;
    const partialContent = Array.isArray(partial?.content) ? partial.content : [];
    const partialToolCall = isRecord(partialContent[index]) ? partialContent[index] : undefined;
    const finalToolCall = isRecord(update.toolCall) ? update.toolCall : undefined;
    const toolCall = finalToolCall ?? partialToolCall;
    const rawId = typeof toolCall?.id === "string" ? toolCall.id : undefined;
    if (!rawId) return [];
    const toolCallId = safeRequiredText(rawId, 128, "unknown");
    const toolName = safeRequiredText(toolCall?.name, 256, "tool");
    const args = projectJsonObject(toolCall?.arguments ?? {});
    if (!this.announcedToolCalls.has(toolCallId)) {
      this.announcedToolCalls.add(toolCallId);
      return [this.frame({ type: "tool.started", data: {
        toolCallId,
        toolName,
        args: args.value,
        ...(args.omittedFields.length === 0 ? {} : { omittedFields: args.omittedFields }),
      } })];
    }
    return [this.frame({ type: "tool.args_updated", data: {
      toolCallId,
      args: args.value,
      ...(args.omittedFields.length === 0 ? {} : { omittedFields: args.omittedFields }),
    } })];
  }

  private projectMessageEnd(event: AgentEvent): AgentEvent[] {
    const message = isRecord(event.message) ? event.message : undefined;
    // Pi 0.99 records system prompt and tool changes as system messages; they are not conversation.
    if (!message || message.role === "system") return [];
    const role = typeof message.role === "string" ? message.role : "system";
    if (role === "toolResult") {
      const toolCallId = safeRequiredText(message.toolCallId, 128, "unknown");
      if (this.completedToolCalls.delete(toolCallId)) return [];
    }
    let messageId: string;
    let dockRole: "user" | "assistant" | "tool" | "system";
    if (role === "assistant") {
      messageId = this.ensureAssistantMessageId();
      dockRole = "assistant";
      this.lastAssistantOutcome = {
        ...(typeof message.stopReason === "string" ? { stopReason: boundedString(message.stopReason, 128, "unknown") } : {}),
        ...(typeof message.errorMessage === "string" ? { error: message.errorMessage } : {}),
      };
    } else if (role === "user") {
      messageId = this.currentUserMessageId ?? `user-runtime-${++this.messageSequence}`;
      dockRole = "user";
    } else if (role === "toolResult") {
      messageId = `tool-result-${safeRequiredText(message.toolCallId, 128, "unknown")}`;
      dockRole = "tool";
    } else {
      messageId = `message-${++this.messageSequence}`;
      dockRole = "system";
    }
    const userProjection = role === "user" ? projectDockUserContent(message.content, this.attachmentContextKey) : undefined;
    const projected = this.frame({ type: "message.completed", data: {
      messageId,
      role: dockRole,
      content: userProjection?.content ?? projectDockContent(message.content),
      ...(role !== "user" || (this.currentUserAttachments ?? userProjection?.attachments) === undefined ? {} : { attachments: structuredClone(this.currentUserAttachments ?? userProjection?.attachments) }),
      ...(typeof message.stopReason === "string" ? { stopReason: boundedString(message.stopReason, 128, "unknown") } : {}),
      ...(typeof message.errorMessage === "string" ? { error: message.errorMessage } : {}),
    } });
    if (role === "assistant") this.currentAssistantMessageId = undefined;
    if (role === "user") { this.currentUserMessageId = undefined; this.currentUserAttachments = undefined; }
    return [projected];
  }

  private projectToolStart(event: AgentEvent): AgentEvent[] {
    const toolCallId = safeRequiredText(event.toolCallId, 128, "unknown");
    const toolName = safeRequiredText(event.toolName, 256, "tool");
    // Nested calls never reach the model as tool calls; they are listed inside their caller, as in Pi.
    if (typeof event.parentToolCallId === "string") {
      const argumentsJson = typeof event.argumentsJson === "string" ? event.argumentsJson : undefined;
      return this.nestedCallsChanged(this.nestedCalls.start(toolCallId, event.parentToolCallId, toolName, argumentsJson));
    }
    const args = projectJsonObject(event.args ?? {});
    if (this.announcedToolCalls.has(toolCallId)) {
      return [this.frame({ type: "tool.args_updated", data: {
        toolCallId,
        args: args.value,
        ...(args.omittedFields.length === 0 ? {} : { omittedFields: args.omittedFields }),
      } })];
    }
    this.announcedToolCalls.add(toolCallId);
    return [this.frame({ type: "tool.started", data: {
      toolCallId,
      toolName,
      args: args.value,
      ...(args.omittedFields.length === 0 ? {} : { omittedFields: args.omittedFields }),
    } })];
  }

  private projectToolUpdate(event: AgentEvent): AgentEvent[] {
    if (typeof event.parentToolCallId === "string") return [];
    const toolCallId = safeRequiredText(event.toolCallId, 128, "unknown");
    const toolName = safeRequiredText(event.toolName, 256, "tool");
    const result = isRecord(event.partialResult) ? event.partialResult : undefined;
    const publishedFile = result?.publishedFile as never;
    const showImageError = typeof result?.showImageError === "string" ? result.showImageError : undefined;
    const text = boundedContentString(redactShowImageResult(toolName, redactDockAttachmentToolResult(toolName, toolResultText(result?.content) ?? ""), publishedFile, showImageError), 256_000);
    const frames: AgentEvent[] = [];
    if (!this.announcedToolCalls.has(toolCallId)) {
      this.announcedToolCalls.add(toolCallId);
      frames.push(this.frame({ type: "tool.started", data: { toolCallId, toolName, args: {} } }));
    }
    const data = {
      toolCallId,
      text,
      ...(Array.isArray(result?.content) ? { content: projectPublicToolContent(toolName, result.content, text) } : {}),
      ...(publishedFile === undefined ? {} : { publishedFile }),
      ...(result?.presentation === undefined ? {} : { presentation: result.presentation as never }),
    };
    this.toolOutputs.set(toolCallId, data);
    const nestedCalls = this.nestedCalls.snapshot(toolCallId);
    frames.push(this.frame({ type: "tool.output_updated", data: { ...data, ...(nestedCalls === undefined ? {} : { nestedCalls }) } }));
    return frames;
  }

  private projectToolEnd(event: AgentEvent): AgentEvent[] {
    const toolCallId = safeRequiredText(event.toolCallId, 128, "unknown");
    const toolName = safeRequiredText(event.toolName, 256, "tool");
    const result = isRecord(event.result) ? event.result : undefined;
    const isError = event.isError === true;
    if (typeof event.parentToolCallId === "string") {
      const root = this.nestedCalls.end(toolCallId, isError, result?.content);
      return root === undefined ? [] : this.nestedCallsChanged(root);
    }
    const nestedCalls = this.nestedCalls.finish(toolCallId);
    this.toolOutputs.delete(toolCallId);
    const publishedFile = result?.publishedFile as never;
    const showImageError = typeof result?.showImageError === "string" ? result.showImageError : undefined;
    const text = boundedContentString(redactShowImageResult(toolName, redactDockAttachmentToolResult(toolName, toolResultText(result?.content) ?? ""), publishedFile, showImageError), 256_000);
    const projected = projectJsonObject({ content: result?.content });
    this.announcedToolCalls.delete(toolCallId);
    this.completedToolCalls.add(toolCallId);
    return [this.frame({ type: "tool.completed", data: {
      toolCallId,
      toolName,
      text,
      isError,
      ...(Array.isArray(result?.content) ? { content: projectPublicToolContent(toolName, result.content, text) } : {}),
      ...(publishedFile === undefined ? {} : { publishedFile }),
      ...(result?.presentation === undefined ? {} : { presentation: result.presentation as never }),
      ...(nestedCalls === undefined ? {} : { nestedCalls }),
      ...(projected.omittedFields.length === 0 ? {} : { omittedFields: projected.omittedFields }),
    } })];
  }

  /** Repeat the calling tool's latest output with its current list of nested calls. */
  private nestedCallsChanged(toolCallId: string): AgentEvent[] {
    const nestedCalls = this.nestedCalls.snapshot(toolCallId);
    if (nestedCalls === undefined || !this.announcedToolCalls.has(toolCallId)) return [];
    const output = this.toolOutputs.get(toolCallId) ?? { toolCallId, text: "" };
    return [this.frame({ type: "tool.output_updated", data: { ...output, nestedCalls } })];
  }

  private ensureAssistantMessageId(): string {
    this.currentAssistantMessageId ??= `assistant-${++this.messageSequence}`;
    return this.currentAssistantMessageId;
  }

  private frame(frame: ConversationFrame): AgentEvent {
    return { type: "dock_conversation_frame", frame };
  }
}

function projectHistoryEntry(
  entry: SessionEntry,
  attachmentContextKey: Uint8Array,
  publishedFiles?: TransientFileRegistry,
  earlier: ReadonlyMap<string, SessionEntry> = new Map(),
): AgentHistoryEntry {
  const base = {
    recordId: entry.id,
    entryId: entry.id,
    ...(entry.parentId === null ? {} : { parentId: entry.parentId }),
    timestamp: entry.timestamp,
  };
  if (entry.type === "message") {
    const message = entry.message as unknown as Record<string, unknown>;
    const role = typeof message.role === "string" ? message.role : "system";
    if (role === "toolResult") {
      const toolCallId = safeRequiredText(message.toolCallId, 128, `tool-${entry.id}`);
      const toolName = safeRequiredText(message.toolName, 256, "tool");
      const isError = message.isError === true;
      const publishedFile = publishedFiles === undefined ? undefined : publishedFileFromDetails(message.details, publishedFiles);
      const showImageError = publishedFiles === undefined ? undefined : publishedFileFailureFromDetails(message.details, publishedFiles);
      const text = boundedContentString(redactShowImageResult(toolName, redactDockAttachmentToolResult(toolName, toolResultText(message.content) ?? ""), publishedFile, showImageError), 256_000);
      const presentation = projectBuiltInToolPresentation(toolName, text, message.details, isError);
      const nestedCalls = projectPiNestedToolCalls(message.nestedCalls);
      let firstText = true;
      return {
        ...base,
        kind: "message",
        source: "tool",
        visibility: "conversation",
        content: boundConversationPreviewBlocks(toolResultParts(message.content).slice(0, MAX_CONVERSATION_CONTENT_BLOCKS).flatMap((part): ContentBlockDto[] => {
          if (part.type === "image") return projectDockContent([part], undefined, publishedFiles);
          const attachMetadata = firstText;
          firstText = false;
          return [{
            type: "tool_result", toolCallId, toolName, isError,
            text: boundedContentString(redactShowImageResult(toolName, redactDockAttachmentToolResult(toolName, part.text as string), publishedFile, showImageError), 256_000),
            ...(attachMetadata && publishedFile !== undefined ? { publishedFile } : {}),
            ...(attachMetadata && presentation !== undefined ? { presentation } : {}),
            ...(attachMetadata && nestedCalls !== undefined ? { nestedCalls } : {}),
          }];
        })),
        toolCallId,
        toolName,
        isError,
        ...(toolName === "show_image" ? {} : projectRecordMetadata(message.details)),
      };
    }
    if (role === "bashExecution") {
      const command = boundedContentString(message.command, MAX_BASH_COMMAND_CHARS);
      const output = boundedContentString(message.output, 256_000);
      return {
        ...base,
        kind: "bash_execution",
        source: "runtime",
        visibility: "conversation",
        content: command.length > 0 || output.length > 0
          ? [{ type: "text", text: boundedContentString(command.length > 0 ? `! ${command}${output ? `\n${output}` : ""}` : output, MAX_TEXT_CHARS) }]
          : [],
        command,
        ...(typeof message.exitCode === "number" && Number.isSafeInteger(message.exitCode) ? { exitCode: message.exitCode } : {}),
        ...(typeof message.cancelled === "boolean" ? { cancelled: message.cancelled } : {}),
        ...(typeof message.truncated === "boolean" ? { truncated: message.truncated } : {}),
        ...(typeof message.fullOutputPath === "string" ? { fullOutputPath: boundedString(message.fullOutputPath, 16_384, "") } : {}),
        ...(typeof message.excludeFromContext === "boolean" ? { excludeFromContext: message.excludeFromContext } : {}),
      };
    }
    if (role === "branchSummary") {
      const summary = boundedContentString(message.summary, MAX_TEXT_CHARS);
      return {
        ...base,
        kind: "branch_summary",
        source: "runtime",
        visibility: "conversation",
        content: summary ? [{ type: "text", text: summary }] : [],
        ...(typeof message.fromId === "string" ? { fromEntryId: safeRequiredText(message.fromId, 128, "unknown") } : {}),
      };
    }
    if (role === "compactionSummary") {
      const summary = boundedContentString(message.summary, MAX_TEXT_CHARS);
      return {
        ...base,
        kind: "compaction_summary",
        source: "runtime",
        visibility: "conversation",
        content: summary ? [{ type: "text", text: summary }] : [],
        ...(typeof message.tokensBefore === "number" && Number.isSafeInteger(message.tokensBefore) && message.tokensBefore >= 0 ? { tokensBefore: message.tokensBefore } : {}),
      };
    }
    if (message.role === "system") {
      // Pi 0.99 records system prompt and tool changes as system messages, not conversation.
      return {
        ...base,
        kind: "message",
        source: "system",
        visibility: "metadata",
        // The names say what changed; the texts (often the whole prompt and every tool) are read on demand.
        content: [],
        systemPrompt: projectSystemPromptChange(message),
      };
    }
    const custom = role === "custom";
    const userProjection = role === "user" ? projectDockUserContent(message.content, attachmentContextKey, publishedFiles) : undefined;
    return {
      ...base,
      kind: custom ? "custom_message" : "message",
      source: custom ? "extension" : role === "user" ? "user" : role === "assistant" ? "assistant" : "system",
      visibility: custom && message.display === false ? "hidden" : "conversation",
      content: userProjection?.content ?? projectDockContent(message.content, undefined, publishedFiles),
      ...(userProjection?.attachments === undefined ? {} : { attachments: userProjection.attachments }),
      ...(typeof message.stopReason === "string" ? { stopReason: boundedString(message.stopReason, 128, "unknown") } : {}),
      ...(typeof message.errorMessage === "string" ? { error: message.errorMessage } : {}),
      ...(custom && typeof message.customType === "string" ? { customType: boundedString(message.customType, 256, "custom") } : {}),
      ...(custom && typeof message.display === "boolean" ? { display: message.display } : {}),
      ...projectRecordMetadata(message.details),
    };
  }
  if (entry.type === "custom_message") {
    return {
      ...base,
      kind: "custom_message",
      source: "extension",
      visibility: entry.display ? "conversation" : "hidden",
      content: projectDockContent(entry.content, undefined, publishedFiles),
      customType: boundedString(entry.customType, 256, "custom"),
      display: entry.display,
      ...projectRecordMetadata(entry.details),
    };
  }
  if (entry.type === "custom") {
    return {
      ...base,
      kind: "custom",
      source: "extension",
      visibility: "metadata",
      content: [],
      customType: boundedString(entry.customType, 256, "custom"),
      ...projectRecordMetadata(entry.data),
    };
  }
  if (entry.type === "thinking_level_change") {
    return { ...base, kind: "thinking_level_change", source: "runtime", visibility: "metadata", content: [], thinkingLevel: boundedString(entry.thinkingLevel, 64, "off") };
  }
  if (entry.type === "model_change") {
    return {
      ...base,
      kind: "model_change",
      source: "runtime",
      visibility: "metadata",
      content: [],
      provider: boundedString(entry.provider, 256, "unknown"),
      modelId: boundedString(entry.modelId, 512, "unknown"),
    };
  }
  if (entry.type === "compaction") {
    return {
      ...base,
      kind: "compaction_summary",
      source: "runtime",
      visibility: "conversation",
      content: entry.summary ? [{ type: "text", text: boundedContentString(entry.summary, MAX_TEXT_CHARS) }] : [],
      firstKeptEntryId: boundedString(entry.firstKeptEntryId, 128, "unknown"),
      tokensBefore: Math.max(0, Math.floor(entry.tokensBefore)),
      ...projectRecordMetadata(entry.details),
    };
  }
  if (entry.type === "branch_summary") {
    return {
      ...base,
      kind: "branch_summary",
      source: "runtime",
      visibility: "conversation",
      content: entry.summary ? [{ type: "text", text: boundedContentString(entry.summary, MAX_TEXT_CHARS) }] : [],
      fromEntryId: boundedString(entry.fromId, 128, "unknown"),
      ...projectRecordMetadata(entry.details),
    };
  }
  if (entry.type === "session_info") {
    return {
      ...base,
      kind: "session_info",
      source: "runtime",
      visibility: "metadata",
      content: [],
      ...(entry.name === undefined ? {} : { name: boundedString(entry.name, 256, "") }),
    };
  }
  if (entry.type === "label") {
    return {
      ...base,
      kind: "label",
      source: "runtime",
      visibility: "metadata",
      content: [],
      targetEntryId: boundedString(entry.targetId, 128, "unknown"),
      ...(entry.label === undefined ? {} : { label: boundedString(entry.label, 256, "") }),
    };
  }
  // Pi 0.99 usage and context-edit records have no Protocol V2 kind of their own:
  // they are runtime custom records that carry their facts in typed fields.
  const runtime = { ...base, kind: "custom", source: "runtime", visibility: "metadata", customType: boundedString(entry.type, 256, "runtime") } as const;
  if (entry.type === "usage") {
    return {
      ...runtime,
      content: [],
      provider: boundedString(entry.provider, 256, "unknown"),
      modelId: boundedString(entry.model, 512, "unknown"),
      usage: projectRecordUsage(entry),
    };
  }
  if (entry.type === "context_edit") {
    const replaced = contextEditReplacement(entry, earlier);
    return {
      ...runtime,
      content: replaced === undefined ? [] : projectHistoryEntry(replaced, attachmentContextKey, publishedFiles).content.map(recordedToolText),
      targetEntryId: boundedString(entry.targetId, 128, "unknown"),
      contextEdit: entry.replacement === null ? "omit" : "replace",
    };
  }
  return { ...runtime, content: [] };
}

/**
 * The edited entry with the replacement as its content, so the replacement is shown (and
 * attachment context or private paths removed) exactly as the original would be.
 */
function contextEditReplacement(entry: Extract<SessionEntry, { type: "context_edit" }>, earlier: ReadonlyMap<string, SessionEntry>): SessionEntry | undefined {
  const target = earlier.get(entry.targetId);
  if (entry.replacement === null || target === undefined) return undefined;
  if (target.type === "message") return { ...target, message: { ...target.message, content: entry.replacement.content } as typeof target.message };
  if (target.type === "custom_message") return { ...target, content: entry.replacement.content as typeof target.content };
  return undefined;
}

/**
 * Replacement content is text about a tool, not the tool call or result itself: an edit made
 * long after its target must not join the tool's history page unit. A tool result preview may
 * be far longer than a text preview; as text it keeps the text preview bound and the rest is
 * read through the record's content reference.
 */
function recordedToolText(block: ContentBlockDto): ContentBlockDto {
  if (block.type === "tool_result") return { type: "text", text: boundedContentString(block.text, MAX_TEXT_CHARS) };
  if (block.type === "tool_call") return { type: "text", text: boundedContentString(`${block.toolName} ${JSON.stringify(block.args)}`, MAX_TEXT_CHARS) };
  return block;
}

/**
 * The texts a system prompt record carries, each with what it is: the instruction text, each
 * section the record sets to a non-empty text, then each added tool's definition, in record order.
 */
function systemPromptBlocks(message: Record<string, unknown>): Array<{ block: SystemPromptBlockDto; text: string }> {
  const blocks: Array<{ block: SystemPromptBlockDto; text: string }> = [];
  const name = (value: unknown): string => safeRequiredText(value, MAX_SYSTEM_PROMPT_NAME_CHARS, "unnamed");
  const instructions = typeof message.content === "string" ? message.content
    : Array.isArray(message.content) ? message.content.flatMap((item) => isRecord(item) && item.type === "text" && typeof item.text === "string" ? [item.text] : []).join("\n")
      : "";
  if (instructions.length > 0) blocks.push({ block: { kind: "instructions" }, text: instructions });
  if (isRecord(message.sections)) {
    for (const [section, text] of Object.entries(message.sections)) {
      if (typeof text === "string" && text.length > 0) blocks.push({ block: { kind: "section", name: name(section) }, text });
    }
  }
  for (const tool of Array.isArray(message.toolsAdded) ? message.toolsAdded : []) {
    if (!isRecord(tool)) continue;
    let text: string;
    try {
      text = JSON.stringify({ name: tool.name, description: tool.description, parameters: tool.parameters }, null, 2);
    } catch {
      text = JSON.stringify({ name: tool.name });
    }
    blocks.push({ block: { kind: "tool", name: name(tool.name) }, text });
  }
  return blocks.slice(0, MAX_CONVERSATION_CONTENT_BLOCKS);
}

function systemPromptTexts(message: Record<string, unknown>): string[] {
  return systemPromptBlocks(message).map((item) => item.text);
}

export function projectSystemPromptChange(message: Record<string, unknown>): SystemPromptChangeDto {
  const sections = isRecord(message.sections) ? Object.entries(message.sections) : [];
  const names = (values: unknown[]): string[] => values.slice(0, MAX_CONVERSATION_CONTENT_BLOCKS)
    .map((value) => safeRequiredText(value, MAX_SYSTEM_PROMPT_NAME_CHARS, "unnamed"));
  const toolNames = (value: unknown): string[] => names(Array.isArray(value) ? value.map((tool) => isRecord(tool) ? tool.name : undefined) : []);
  return {
    sections: names(sections.filter(([, text]) => typeof text === "string").map(([name]) => name)),
    removedSections: names(sections.filter(([, text]) => text === null).map(([name]) => name)),
    toolsAdded: toolNames(message.toolsAdded),
    toolsRemoved: toolNames(message.toolsRemoved),
    blocks: systemPromptBlocks(message).map((item) => item.block),
  };
}

export function projectRecordUsage(entry: Extract<SessionEntry, { type: "usage" }>): RecordUsageDto {
  const usage = isRecord(entry.usage) ? entry.usage as unknown as Record<string, unknown> : {};
  const cost = isRecord(usage.cost) ? usage.cost : {};
  const count = (value: unknown): number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
  const tokens = { input: count(usage.input), output: count(usage.output), cacheRead: count(usage.cacheRead), cacheWrite: count(usage.cacheWrite) };
  const note = safeOptionalText(entry.note, MAX_RECORD_USAGE_TEXT_CHARS);
  return {
    kind: safeRequiredText(entry.kind, MAX_RECORD_USAGE_TEXT_CHARS, "usage"),
    tokens: { ...tokens, total: count(usage.totalTokens) || tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite },
    cost: typeof cost.total === "number" && Number.isFinite(cost.total) && cost.total >= 0 ? cost.total : 0,
    ...(note === undefined ? {} : { note }),
  };
}

function projectDockUserContent(content: unknown, attachmentContextKey: Uint8Array, publishedFiles?: TransientFileRegistry): { content: ContentBlockDto[]; attachments?: AttachmentDto[] } {
  if (typeof content === "string") {
    const extracted = extractDockAttachmentContext(content, attachmentContextKey);
    return { content: projectDockContent(extracted.text, undefined, publishedFiles), ...(extracted.attachments === undefined ? {} : { attachments: extracted.attachments }) };
  }
  if (!Array.isArray(content)) return { content: projectDockContent(content, undefined, publishedFiles) };
  let attachments: AttachmentDto[] | undefined;
  const visible = content.map((item) => {
    if (!isRecord(item) || item.type !== "text" || typeof item.text !== "string") return item;
    const extracted = extractDockAttachmentContext(item.text, attachmentContextKey);
    if (extracted.attachments === undefined) return item;
    attachments = extracted.attachments;
    return { ...item, text: extracted.text };
  });
  return { content: projectDockContent(visible, attachments, publishedFiles), ...(attachments === undefined ? {} : { attachments }) };
}

function projectPublicToolContent(toolName: string, content: unknown, redactedText: string): ContentBlockDto[] {
  if (toolName === "show_image" || toolName === DOCK_ATTACHMENT_RESOLVE_TOOL) {
    return redactedText.length === 0 ? [] : [{ type: "text", text: redactedText }];
  }
  return projectDockContent(content);
}

function projectDockContent(content: unknown, attachments?: readonly AttachmentDto[], publishedFiles?: TransientFileRegistry): ContentBlockDto[] {
  if (typeof content === "string") return content.length > 0 ? [{ type: "text", text: boundedContentString(content, MAX_TEXT_CHARS) }] : [];
  if (!Array.isArray(content)) return [];
  const imageAttachments = new Map<string, AttachmentDto[]>();
  for (const attachment of attachments ?? []) {
    if (safeImageMimeType(attachment.mediaType) !== attachment.mediaType) continue;
    const key = `${attachment.sha256}\u0000${attachment.mediaType}`;
    const matches = imageAttachments.get(key) ?? [];
    matches.push(attachment);
    imageAttachments.set(key, matches);
  }
  const blocks: ContentBlockDto[] = [];
  for (const item of content.slice(0, MAX_CONVERSATION_CONTENT_BLOCKS)) {
    if (!isRecord(item)) continue;
    let block: ContentBlockDto | undefined;
    if (item.type === "text" && typeof item.text === "string") block = { type: "text", text: boundedContentString(item.text, MAX_TEXT_CHARS) };
    else if (item.type === "thinking" && typeof item.thinking === "string") block = { type: "thinking", text: boundedContentString(item.thinking, MAX_TEXT_CHARS) };
    else if (item.type === "image") {
      const mimeType = safeImageMimeType(item.mimeType);
      const registered = registerConversationImage(publishedFiles, typeof item.data === "string" ? item.data : undefined, mimeType, item);
      const sha256 = typeof item.sha256 === "string" && /^[a-f0-9]{64}$/u.test(item.sha256)
        ? item.sha256
        : registered?.sha256 ?? (typeof item.data === "string" ? imageBase64Metadata(item.data)?.sha256 : undefined);
      const contentRef = typeof item.contentRef === "string"
        ? safeRequiredText(item.contentRef, 128, "unknown")
        : registered?.contentRef;
      const matches = sha256 === undefined ? undefined : imageAttachments.get(`${sha256}\u0000${mimeType}`);
      const fileId = matches?.shift()?.fileId;
      block = {
        type: "image",
        mimeType,
        ...(contentRef === undefined ? {} : { contentRef }),
        ...(fileId === undefined ? {} : { fileId }),
      };
    }
    else if ((item.type === "toolCall" || item.type === "tool_call") && typeof item.name === "string") {
      const projected = projectJsonObject(item.arguments);
      block = {
        type: "tool_call",
        toolCallId: safeRequiredText(item.id, 128, "unknown"),
        toolName: safeRequiredText(item.name, 256, "tool"),
        args: projected.value,
        ...(projected.omittedFields.length > 0 ? { omittedFields: projected.omittedFields } : {}),
      };
    }
    if (block === undefined) continue;
    blocks.push(block);
  }
  return boundConversationPreviewBlocks(blocks);
}

function boundConversationPreviewBlocks(blocks: ContentBlockDto[]): ContentBlockDto[] {
  // Reserve tool and media identities before spending bytes in source order.
  // If arguments/text no longer fit, emit their slim identity, never lose the
  // tool edge that both Host and Worker semantic pagination depend on.
  const identities = blocks.map(slimSemanticHistoryBlock);
  const size = (block: ContentBlockDto | undefined): number => block === undefined ? 0 : Buffer.byteLength(JSON.stringify(block), "utf8") + 1;
  let remaining = 512_000 - 2 - identities.reduce((total, block) => total + size(block), 0);
  return blocks.flatMap((block, index) => {
    const identity = identities[index];
    const extra = size(block) - size(identity);
    if (extra <= remaining) { remaining -= extra; return [block]; }
    return identity === undefined ? [] : [identity];
  });
}

function projectRecordMetadata(value: unknown): { metadata?: JsonValue; metadataOmittedFields?: string[] } {
  if (value === undefined) return {};
  const projected = projectJsonObject({ value });
  const metadata = projected.value.value;
  return {
    ...(metadata === undefined ? {} : { metadata }),
    ...(projected.omittedFields.length === 0 ? {} : {
      metadataOmittedFields: projected.omittedFields.map((path) => path === "/value" ? "/" : path.replace(/^\/value/u, "")),
    }),
  };
}

type ConversationTextSourceBlock = { type: "text" | "thinking"; text: string };
type ConversationOmittedSourceBlock = { type: "omitted"; kind: "image" | "binary"; description: string };
type ConversationSourceBlock =
  | ConversationTextSourceBlock
  | { type: "image"; mimeType: string; data: string; contentRef?: string; fileId?: string }
  | { type: "tool_call"; toolCallId: string; toolName: string; argumentsJson: string }
  | { type: "tool_result"; toolCallId: string; toolName: string; text: string; isError: boolean; publishedFile?: PublishedFileDto; nestedCalls?: NestedToolCallsDto; omittedFields?: string[] }
  | ConversationOmittedSourceBlock;

/** Whether a conversation.content page with these chunks stays within the Worker's page bound. */
function contentPageFits(revision: string, contentRef: string, chunks: readonly AgentConversationContentChunk[]): boolean {
  const page = { revision, contentRef, chunks, complete: false, nextCursor: randomUUID() };
  return Buffer.byteLength(JSON.stringify(page), "utf8") <= MAX_CONVERSATION_CONTENT_PAGE_BYTES;
}

function conversationContentBlocks(
  entry: SessionEntry,
  projected: AgentHistoryEntry,
  attachmentContextKey: Uint8Array,
  publishedFiles: TransientFileRegistry,
  earlier: ReadonlyMap<string, SessionEntry> = new Map(),
): ConversationSourceBlock[] {
  if (entry.type === "context_edit") {
    const replaced = contextEditReplacement(entry, earlier);
    return replaced === undefined ? [] : conversationContentBlocks(replaced, projectHistoryEntry(replaced, attachmentContextKey, publishedFiles), attachmentContextKey, publishedFiles)
      .map((block): ConversationSourceBlock => block.type === "tool_result" ? { type: "text", text: block.text }
        : block.type === "tool_call" ? { type: "text", text: `${block.toolName} ${block.argumentsJson}` } : block);
  }
  // Reuse canonical image identities in source order, independently of text clipping.
  const images = projected.content.filter((block) => block.type === "image")[Symbol.iterator]();
  const imageSource = (item: Record<string, unknown>): Extract<ConversationSourceBlock, { type: "image" }> => {
    const contentRef = publishedFiles.imageReference(item);
    return {
      ...conversationImageSource(item),
      ...(contentRef === undefined ? {} : { contentRef }),
      ...images.next().value,
    };
  };
  const omitted = (kind: "image" | "binary", description: string): ConversationOmittedSourceBlock => ({ type: "omitted", kind, description });
  const text = (type: "text" | "thinking", value: unknown): ConversationTextSourceBlock | undefined => (
    typeof value === "string" && value.length > 0 ? { type, text: value } : undefined
  );
  const textBlocks = (type: "text" | "thinking", value: unknown): ConversationSourceBlock[] => {
    const block = text(type, value);
    return block === undefined ? [] : [block];
  };
  if (entry.type === "compaction" || entry.type === "branch_summary") return textBlocks("text", entry.summary);
  if (entry.type === "thinking_level_change" || entry.type === "model_change" || entry.type === "session_info") {
    return [];
  }
  let content = entry.type === "custom_message"
    ? entry.content
    : entry.type === "message"
      ? (entry.message as unknown as Record<string, unknown>).content
      : undefined;
  if (entry.type === "message") {
    const message = entry.message as unknown as Record<string, unknown>;
    if (message.role === "system") return systemPromptTexts(message).flatMap((value) => textBlocks("text", value));
    const role = typeof message.role === "string" ? message.role : "system";
    if (role === "bashExecution") {
      const command = typeof message.command === "string" ? message.command : "";
      const output = typeof message.output === "string" ? message.output : "";
      return textBlocks("text", command.length > 0 ? `! ${command}${output ? `\n${output}` : ""}` : output);
    }
    if (role === "branchSummary" || role === "compactionSummary") return textBlocks("text", message.summary);
    if (role === "toolResult") {
      const toolCallId = typeof message.toolCallId === "string" ? boundedString(message.toolCallId, 128, "unknown") : "unknown";
      const toolName = typeof message.toolName === "string" ? boundedString(message.toolName, 256, "tool") : "tool";
      const isError = message.isError === true;
      const projectedToolResult = projected.content.find((block) => block.type === "tool_result");
      let firstText = true;
      return toolResultParts(message.content).map((part): ConversationSourceBlock => {
        if (part.type === "image") return imageSource(part);
        const attachMetadata = firstText;
        firstText = false;
        return {
          type: "tool_result", toolCallId, toolName, isError,
          text: redactShowImageResult(toolName, redactDockAttachmentToolResult(toolName, part.text as string),
            projectedToolResult?.publishedFile, projectedToolResult?.text ?? SHOW_IMAGE_UNAVAILABLE_MESSAGE),
          ...(attachMetadata && projectedToolResult?.publishedFile !== undefined ? { publishedFile: projectedToolResult.publishedFile } : {}),
          ...(attachMetadata && projectedToolResult?.nestedCalls !== undefined ? { nestedCalls: projectedToolResult.nestedCalls } : {}),
        };
      });
    }
    if (role === "user") content = stripDockAttachmentContext(content, attachmentContextKey);
  }
  const items = typeof content === "string" ? [{ type: "text", text: content }] : Array.isArray(content) ? content : [];
  return items.flatMap((item): ConversationSourceBlock[] => {
    if (!isRecord(item)) return [];
    if (item.type === "text") return textBlocks("text", item.text);
    if (item.type === "thinking") return textBlocks("thinking", item.thinking);
    if (item.type === "image") return [imageSource(item)];
    if ((item.type === "toolCall" || item.type === "tool_call") && typeof item.name === "string") {
      try {
        const argumentsJson = JSON.stringify(item.arguments ?? {});
        return [{
          type: "tool_call",
          toolCallId: safeRequiredText(item.id, 128, "unknown"),
          toolName: safeRequiredText(item.name, 256, "tool"),
          argumentsJson,
        }];
      } catch {
        return [omitted("binary", "Unserializable tool arguments omitted")];
      }
    }
    return [];
  });
}

/** Preserve image/text ordering; only neighboring text items share a result block. */
function toolResultParts(content: unknown): Record<string, unknown>[] {
  const items = typeof content === "string" ? [{ type: "text", text: content }] : Array.isArray(content) ? content : [];
  const parts: Record<string, unknown>[] = [];
  let hasText = false;
  for (const item of items) {
    if (!isRecord(item)) continue;
    if (item.type === "image") parts.push(item);
    else if (item.type === "text" && typeof item.text === "string") {
      const previous = parts.at(-1);
      if (previous?.type === "text") previous.text = `${previous.text}${item.text}`;
      else parts.push({ type: "text", text: item.text });
      hasText = true;
    }
  }
  // Image-only tools still need their tool-result identity, not invented text.
  if (!hasText) parts.unshift({ type: "text", text: "" });
  return parts;
}

function conversationImageSource(item: Record<string, unknown>): Extract<ConversationSourceBlock, { type: "image" }> {
  const mimeType = safeImageMimeType(item.mimeType);
  const data = typeof item.data === "string" ? item.data : "";
  return { type: "image", mimeType, data };
}

function stripDockAttachmentContext(content: unknown, attachmentContextKey: Uint8Array): unknown {
  if (typeof content === "string") return extractDockAttachmentContext(content, attachmentContextKey).text;
  if (!Array.isArray(content)) return content;
  return content.map((item) => (
    isRecord(item) && item.type === "text" && typeof item.text === "string"
      ? { ...item, text: extractDockAttachmentContext(item.text, attachmentContextKey).text }
      : item
  ));
}

/** Exact content comparison after every preview transform; metadata is separate. */
function conversationPreviewIsComplete(blocks: readonly ConversationSourceBlock[], entry: AgentHistoryEntry, view?: "references"): boolean {
  if (blocks.length !== entry.content.length) return false;
  return blocks.every((source, index) => {
    const preview = entry.content[index]!;
    if (source.type !== preview.type) return false;
    switch (source.type) {
      case "text": case "thinking":
        return (preview.type === "text" || preview.type === "thinking") && source.text === preview.text;
      case "image":
        // Legacy readers only fetch original image bytes when this is false.
        // A descriptor enables the separate image path, but is not an inline
        // complete preview for consumers of conversation.content.
        return view === "references" && preview.type === "image"
          && source.mimeType === preview.mimeType && source.contentRef === preview.contentRef && source.fileId === preview.fileId;
      case "tool_call":
        return preview.type === "tool_call" && !preview.omittedFields?.length
          && source.argumentsJson === JSON.stringify(preview.args);
      case "tool_result":
        return preview.type === "tool_result" && !preview.omittedFields?.length && source.text === preview.text
          && JSON.stringify(source.publishedFile) === JSON.stringify(preview.publishedFile)
          && JSON.stringify(source.nestedCalls) === JSON.stringify(preview.nestedCalls);
      case "omitted":
        return preview.type === "omitted" && preview.kind === source.kind && preview.description === source.description;
    }
  });
}

export function unicodeSafeEnd(value: string, requestedEnd: number): number {
  return requestedEnd > 0
    && /[\uD800-\uDBFF]/u.test(value[requestedEnd - 1] ?? "")
    && /[\uDC00-\uDFFF]/u.test(value[requestedEnd] ?? "")
    ? requestedEnd - 1
    : requestedEnd;
}

function conversationContentRef(sessionId: string, entryId: string): string {
  return createHash("sha256").update(sessionId).update("\u0000").update(entryId).digest("hex");
}

export function trimTokenMap<T>(map: Map<string, T>, max = 8_192): void {
  while (map.size > max) map.delete(map.keys().next().value as string);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * conversation.history entries carry bounded previews; complete content is read
 * through conversation.content refs. This is the only preview projection point.
 */
function previewConversationEntry(entry: AgentHistoryEntry): AgentHistoryEntry {
  const content: AgentHistoryEntry["content"] = [];
  let remaining = 4_000;
  for (const [index, block] of entry.content.entries()) {
    // Media identities remain visible even after text/block preview limits.
    if (index >= 16 && block.type !== "image" && block.type !== "tool_call" && block.type !== "tool_result") continue;
    if (block.type === "text" || block.type === "thinking") {
      const text = block.text.length <= remaining ? block.text : block.text.slice(0, unicodeSafeEnd(block.text, remaining));
      if (text.length > 0) content.push({ type: block.type, text });
      remaining = Math.max(0, remaining - text.length);
    } else if (block.type === "tool_call") {
      const size = JSON.stringify(block.args).length;
      if (size <= remaining) {
        content.push(block);
        remaining -= size;
      } else content.push(slimSemanticHistoryBlock(block)!);
    } else if (block.type === "tool_result") {
      const text = block.text.length <= remaining ? block.text : block.text.slice(0, unicodeSafeEnd(block.text, remaining));
      const { presentation: _presentation, ...metadata } = block;
      content.push(text === block.text ? block : { ...metadata, text });
      remaining = Math.max(0, remaining - text.length);
    } else {
      content.push(block);
    }
  }
  return { ...entry, content };
}

export async function loadAttachmentContextKey(agentDir: string): Promise<Buffer> {
  await mkdir(agentDir, { recursive: true, mode: 0o700 });
  const keyPath = join(agentDir, ".alu-dock-attachment-context-key");
  for (;;) {
    try {
      const handle = await open(keyPath, fsConstants.O_RDONLY | noFollowFlag());
      try {
        const details = await handle.stat();
        const getuid = process.getuid;
        if (!details.isFile() || (typeof getuid === "function" && details.uid !== getuid())) {
          throw new Error("Dock attachment context key is not a regular user-owned file");
        }
        await hardenWindowsPrivatePath(keyPath, false);
        await handle.chmod(0o600);
        const encoded = (await handle.readFile("utf8")).trim();
        const key = Buffer.from(encoded, "base64");
        if (key.length !== 32 || key.toString("base64") !== encoded) throw new Error("Dock attachment context key is invalid");
        return key;
      } finally { await handle.close(); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const key = randomBytes(32);
    try {
      const handle = await open(keyPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollowFlag(), 0o600);
      try {
        await handle.writeFile(`${key.toString("base64")}\n`, "utf8");
        await handle.sync();
      } finally { await handle.close(); }
      await hardenWindowsPrivatePath(keyPath, false);
      return key;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
}
