import {
  MAX_ASSISTANT_DOCUMENT_BYTES,
  type AssistantPreview,
  type AssistantRequest,
  type AssistantResultFor,
  type AssistantSource,
} from "../core/assistant.js";
import type { AssistantDocuments } from "./documents.js";
import type { AssistantStore } from "./store.js";

/**
 * The assistant service's answers (card #295). It runs in its own process on Main, holds her persona,
 * the owner's notes and her recorded conversations, and answers the Works opened as her and the
 * owner's clients alike.
 */
export class AssistantCore {
  constructor(
    private readonly documents: AssistantDocuments,
    private readonly store: AssistantStore,
    private readonly workspacePath: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async answer<R extends AssistantRequest>(request: R, source: AssistantSource): Promise<AssistantResultFor<R>> {
    return await this.dispatch(request, source) as AssistantResultFor<R>;
  }

  private async dispatch(request: AssistantRequest, source: AssistantSource): Promise<unknown> {
    switch (request.op) {
      case "info": return { workspacePath: this.workspacePath, maxDocumentBytes: MAX_ASSISTANT_DOCUMENT_BYTES };
      case "load": return this.preview();
      case "recorded": return this.store.recorded(request.sessionId);
      case "record": return this.store.record(request.session, request.entries, request.throughEntryId, source);
      case "search": return this.store.search(request);
      case "context": return this.store.context(request);
      case "document_get": return this.documents.get(request.document);
      case "document_set": return this.documents.set(request.document, request.text, request.baseRevision);
      case "document_edit": return this.documents.edit(request.document, request.oldText, request.newText);
    }
  }

  /** Exactly what a new assistant session loads: the persona, the owner's notes, and how to recall more. */
  private async preview(): Promise<AssistantPreview> {
    const loaded = this.now();
    const [persona, notes] = await Promise.all([this.documents.get("persona"), this.documents.get("notes")]);
    const parts = [persona.text.trim()];
    if (notes.text.trim().length > 0) {
      parts.push(`## 主人亲手写的设定\n\n这些是主人亲手写下的事实和规矩，和别的说法冲突时以这里为准。\n\n${notes.text.trim()}`);
    }
    parts.push([
      "## 记忆",
      "",
      `这份资料载入于 ${localTime(loaded)}。之后新记住或改过的东西不在这里；拿不准时先查，别凭印象说。`,
      "",
      "- 用 assistant_search 按关键词和时间搜你和主人过去的对话，搜不到就换个说法再搜。",
      "- 用 assistant_read 看某一条前后的原话，包括当时调用的工具和查到的结果。",
      "- 用 assistant_document 读和改你的人设（persona）和主人的手写设定（notes）。",
    ].join("\n"));
    return { text: parts.filter((part) => part.length > 0).join("\n\n"), loadedAt: loaded.toISOString() };
  }
}

/** Main's local time with its offset, such as "2026-11-07 15:04（UTC+08:00）". */
export function localTime(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}（UTC${sign}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}）`;
}
