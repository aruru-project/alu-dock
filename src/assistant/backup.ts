import { randomBytes } from "node:crypto";
import { constants, existsSync } from "node:fs";
import { copyFile, mkdir, rename, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { dirname, join, resolve } from "node:path";

import { ASSISTANT_DOCUMENTS, type AssistantDocumentName } from "../core/assistant.js";
import { documentFileName } from "./documents.js";

/** Her recorded conversations, next to the two documents in the assistant directory. */
export const ASSISTANT_DATABASE_FILE = "memory.sqlite";

export interface AssistantBackup {
  directory: string;
  memory: boolean;
  documents: AssistantDocumentName[];
}

/**
 * Copies the assistant directory as it stands now, while the Host keeps running and recording. The
 * memory is copied in one read of the database (with what is still in its write-ahead log), the
 * documents as last saved. Whatever is said while the copy runs is left for the next backup. The copy
 * is assembled beside `target` and renamed into place, so a directory with the target's name is
 * always a whole backup.
 */
export async function backupAssistant(source: string, target: string): Promise<AssistantBackup> {
  const directory = resolve(target);
  if (!existsSync(source)) throw new Error(`There is no assistant data at ${source}. Her persona, notes and memory are kept on Main.`);
  if (existsSync(directory)) throw new Error(`${directory} already exists. Choose a new directory for the backup.`);
  await mkdir(dirname(directory), { recursive: true });
  const partial = `${directory}.partial-${randomBytes(4).toString("hex")}`;
  await mkdir(partial);
  try {
    const memory = copyMemory(join(source, ASSISTANT_DATABASE_FILE), join(partial, ASSISTANT_DATABASE_FILE));
    const documents: AssistantDocumentName[] = [];
    for (const document of ASSISTANT_DOCUMENTS) {
      try {
        await copyFile(join(source, documentFileName(document)), join(partial, documentFileName(document)), constants.COPYFILE_EXCL);
        documents.push(document);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    await rename(partial, directory);
    return { directory, memory, documents };
  } catch (error) {
    await rm(partial, { recursive: true, force: true });
    throw error;
  }
}

function copyMemory(database: string, copy: string): boolean {
  if (!existsSync(database)) return false;
  // Read-only, so the copy never changes her memory; the service may keep writing meanwhile.
  const db = new DatabaseSync(database, { readOnly: true });
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    db.prepare("VACUUM INTO ?").run(copy);
  } finally {
    db.close();
  }
  return true;
}
