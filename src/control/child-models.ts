import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { MAX_CHILD_MODELS, MAX_MODEL_ID_CHARS, MAX_MODEL_PROVIDER_CHARS, type ChildModelsResult, type ChildModelsSetResult, type ModelRef } from "./protocol.js";
import { ModelVisibilityError, modelKey, readModelCatalog, type ModelCatalogReader, type ModelVisibilityPort } from "./model-visibility.js";
import { parseChildModelEntries, type ChildModelList } from "../core/dock-tools.js";
import { writePrivateStateFile } from "../platform/private-state.js";

/** Hand-edited list in the Host state directory; documented in docs/local-install.md. */
export const CHILD_MODELS_FILE = "child-models.json";
// Room for hand formatting around the largest accepted list.
const MAX_FILE_BYTES = 4 * MAX_CHILD_MODELS * ((MAX_MODEL_PROVIDER_CHARS + MAX_MODEL_ID_CHARS) * 4 + 64);

/** Where a Host reads the child Work list; a SubHost reads Main's (card #303). */
export interface ChildModelsSource {
  read(): Promise<ChildModelList>;
}

/** The settings pages' view of the list; only Main has one, so only Main's Host offers it. */
export interface ChildModelsEditor {
  get(): Promise<ChildModelsResult>;
  set(models: readonly ModelRef[]): Promise<ChildModelsSetResult>;
}

/**
 * The models the user shows Agents for child Works, kept on Main.
 * Problems are worded for the Agent reading dock_models, which tells the user.
 * It guides what an Agent picks; it does not limit which model a child Work may use.
 * Read on every request, so an edit applies without a restart.
 */
export class ChildModelsStore implements ChildModelsSource {
  readonly filePath: string;
  private writing: Promise<unknown> = Promise.resolve();

  constructor(readonly stateRoot: string) {
    this.filePath = join(resolve(stateRoot), CHILD_MODELS_FILE);
  }

  /** Replace the whole list, keeping its order and dropping repeats; the last save wins. */
  write(models: readonly ModelRef[]): Promise<ModelRef[]> {
    const next = [...new Map(models.map((model) => [modelKey(model), { provider: model.provider, id: model.id }])).values()];
    const task = this.writing.then(async () => {
      try {
        await writePrivateStateFile(this.stateRoot, CHILD_MODELS_FILE, formatChildModelsFile(next));
      } catch (error) {
        throw new ModelVisibilityError("child_models_write_failed", "子 Work 模型名单没有保存成功，原来的名单不变。请检查 Main 的磁盘空间和 Alu Dock 状态目录的权限，然后再试。", true, { cause: error });
      }
    });
    this.writing = task.catch(() => {});
    return task.then(() => next);
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

/**
 * Main's list with the models to pick from: those a new Work can select, less hidden ones.
 * The Host also reads the list through it for dock_models.
 */
export class ChildModelsService implements ChildModelsSource, ChildModelsEditor {
  constructor(private readonly store: ChildModelsStore, private readonly catalog: ModelCatalogReader, private readonly visibility?: ModelVisibilityPort) {}

  read(): Promise<ChildModelList> {
    return this.store.read();
  }

  async get(): Promise<ChildModelsResult> {
    const [catalog, file] = await Promise.all([readModelCatalog(this.catalog), this.store.read()]);
    const selectable = this.visibility ? await this.visibility.filterModelList(catalog) : catalog;
    return { ...selectable, listed: file.models, ...(file.problem === undefined ? {} : { fileProblem: file.problem }) };
  }

  async set(models: readonly ModelRef[]): Promise<ChildModelsSetResult> {
    return { listed: await this.store.write(models) };
  }
}

/** One entry per line so a person or Agent can edit the file by hand. */
function formatChildModelsFile(models: readonly ModelRef[]): string {
  if (models.length === 0) return "{\n  \"models\": []\n}\n";
  return `{\n  "models": [\n${models.map((model) => `    ${JSON.stringify({ provider: model.provider, id: model.id })}`).join(",\n")}\n  ]\n}\n`;
}
