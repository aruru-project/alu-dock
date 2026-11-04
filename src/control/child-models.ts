import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { MAX_CHILD_MODEL_NOTE_CHARS, MAX_CHILD_MODELS, parseChildModelEntries, type ChildModelList } from "../core/dock-tools.js";

/** Hand-edited list in the Host state directory; documented in docs/local-install.md. */
export const CHILD_MODELS_FILE = "child-models.json";
// Room for hand formatting around the largest accepted list.
const MAX_FILE_BYTES = 4 * MAX_CHILD_MODELS * (MAX_CHILD_MODEL_NOTE_CHARS * 4 + 1_024);

/**
 * The models the user shows Agents for child Works on this machine, with the user's notes.
 * Problems are worded for the Agent reading dock_models, which tells the user.
 * It guides what an Agent picks; it does not limit which model a child Work may use.
 * Read on every request, so an edit applies without a restart.
 */
export class ChildModelsStore {
  readonly filePath: string;

  constructor(stateRoot: string) {
    this.filePath = join(resolve(stateRoot), CHILD_MODELS_FILE);
  }

  async read(): Promise<ChildModelList> {
    let bytes: Buffer;
    try {
      bytes = await readFile(this.filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { models: [] };
      return { models: [], problem: `${CHILD_MODELS_FILE} could not be read; check its permissions` };
    }
    if (bytes.byteLength > MAX_FILE_BYTES) return { models: [], problem: `${CHILD_MODELS_FILE} is too large` };
    let value: unknown;
    try {
      value = JSON.parse(bytes.toString("utf8"));
    } catch {
      return { models: [], problem: `${CHILD_MODELS_FILE} is not valid JSON` };
    }
    if (value === null || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => key !== "models")) {
      return { models: [], problem: `${CHILD_MODELS_FILE} must contain only "models" at the top level` };
    }
    try {
      return { models: parseChildModelEntries((value as { models?: unknown }).models ?? []) };
    } catch (error) {
      return { models: [], problem: `${CHILD_MODELS_FILE}: ${error instanceof Error ? error.message : String(error)}` };
    }
  }
}
