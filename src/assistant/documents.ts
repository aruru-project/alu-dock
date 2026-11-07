import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";

import { AssistantError, MAX_ASSISTANT_DOCUMENT_BYTES, type AssistantDocument, type AssistantDocumentName } from "../core/assistant.js";
import { DEFAULT_PERSONA } from "./default-persona.js";

/**
 * The persona and the owner's hand-written notes, as two Markdown files in the assistant directory
 * on Main. The owner may edit them by hand too; the revision is the content's digest, so a change
 * made anywhere is noticed by the next save that started from the older text.
 */
export class AssistantDocuments {
  private tail: Promise<unknown> = Promise.resolve();

  constructor(private readonly directory: string) {}

  /** Writes the shipped persona when there is none, and an empty notes file; existing files stay as they are. */
  async initialize(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await createIfMissing(this.path("persona"), DEFAULT_PERSONA);
    await createIfMissing(this.path("notes"), "");
  }

  async get(document: AssistantDocumentName): Promise<AssistantDocument> {
    const text = await readFile(this.path(document), "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return "";
      throw error;
    });
    return { document, text, revision: revisionOf(text) };
  }

  /** Replaces the text; with `baseRevision` only when nobody changed it since that revision was read. */
  set(document: AssistantDocumentName, text: string, baseRevision?: string): Promise<AssistantDocument> {
    return this.serialize(async () => {
      if (baseRevision !== undefined && (await this.get(document)).revision !== baseRevision) {
        throw new AssistantError("assistant_document_changed", "这份内容在别处被改过了，这次没有保存。请重新读取后再改。");
      }
      await writeWhole(this.path(document), text);
      return { document, text, revision: revisionOf(text) };
    });
  }

  /** Replaces one exact passage, which must occur exactly once. */
  edit(document: AssistantDocumentName, oldText: string, newText: string): Promise<AssistantDocument> {
    return this.serialize(async () => {
      const current = (await this.get(document)).text;
      const first = current.indexOf(oldText);
      if (first < 0) throw new AssistantError("assistant_edit_not_found", "要替换的那段原文没有找到，内容没有改动。请先读一遍现在的内容，再照原样引用。");
      if (current.indexOf(oldText, first + 1) >= 0) throw new AssistantError("assistant_edit_not_found", "要替换的那段原文出现了不止一次，内容没有改动。请多带一些前后文，让它只出现一次。");
      const text = current.slice(0, first) + newText + current.slice(first + oldText.length);
      if (Buffer.byteLength(text, "utf8") > MAX_ASSISTANT_DOCUMENT_BYTES) throw new AssistantError("assistant_document_too_large", `改完后内容会超过 ${MAX_ASSISTANT_DOCUMENT_BYTES / 1024} KB，没有保存。请删短一些再改。`);
      await writeWhole(this.path(document), text);
      return { document, text, revision: revisionOf(text) };
    });
  }

  private path(document: AssistantDocumentName): string { return join(this.directory, `${document}.md`); }

  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const next = this.tail.then(work, work);
    this.tail = next.catch(() => {});
    return next;
  }
}

export function revisionOf(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

async function createIfMissing(path: string, text: string): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    try { await handle.writeFile(text); await handle.sync(); }
    finally { await handle.close(); }
    // Publish only complete bytes, and never over a file that is already there.
    try { await link(temporary, path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  } finally { await rm(temporary, { force: true }); }
}

async function writeWhole(path: string, text: string): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, "wx", 0o600);
    try { await handle.writeFile(text); await handle.sync(); }
    finally { await handle.close(); }
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}
