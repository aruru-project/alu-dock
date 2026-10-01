import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import type { AgentModelInfo } from "../core/agent-worker.js";
import { syncPrivateDirectory } from "../platform/private-state.js";
import {
  MAX_HIDDEN_MODELS_BYTES,
  parseModelRefs,
  ProtocolValidationError,
  type ModelRef,
  type ModelVisibilityResult,
  type ModelVisibilitySetResult,
} from "./protocol.js";

/** Plain, hand-editable list in the Host state directory; documented in docs/local-install.md. */
export const MODEL_VISIBILITY_FILE = "model-visibility.json";
// Leaves room for hand formatting around the largest accepted list.
const MAX_FILE_BYTES = 4 * MAX_HIDDEN_MODELS_BYTES;
const WINDOWS_REPLACE_RETRY_DELAYS_MS = [10, 25, 50, 100, 200] as const;

interface ModelList {
  models: AgentModelInfo[];
  total: number;
  truncated: boolean;
}

/** The models a new Work on this machine can select, produced by the Agent adapter without a Work. */
export interface ModelCatalogReader {
  read(): Promise<ModelList>;
}

export interface HiddenModelsFile {
  hidden: ModelRef[];
  /** Why a hand-edited file could not be used; nothing is hidden until it is saved again. */
  problem?: string;
}

/** The list sits beside the Host catalog, in the same private state directory as the other Host settings. */
export function modelVisibilityStateRoot(catalogPath: string): string {
  return dirname(resolve(catalogPath));
}

export class ModelVisibilityError extends Error {
  constructor(readonly code: "model_catalog_unavailable" | "model_visibility_write_failed", message: string, readonly retryable: boolean, options?: ErrorOptions) {
    super(message, options);
    this.name = "ModelVisibilityError";
  }
}

/** One machine's hidden-model list. This Host reads it on every model list it returns. */
export class ModelVisibilityStore {
  readonly filePath: string;
  private writing: Promise<unknown> = Promise.resolve();

  constructor(readonly stateRoot: string) {
    this.filePath = join(resolve(stateRoot), MODEL_VISIBILITY_FILE);
  }

  async read(): Promise<HiddenModelsFile> {
    let bytes: Buffer;
    try {
      bytes = await readFile(this.filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { hidden: [] };
      return { hidden: [], problem: `${MODEL_VISIBILITY_FILE} 读不出来（${(error as NodeJS.ErrnoException).code ?? "未知原因"}）` };
    }
    if (bytes.byteLength > MAX_FILE_BYTES) return { hidden: [], problem: `${MODEL_VISIBILITY_FILE} 太大，隐藏的模型太多` };
    let value: unknown;
    try {
      value = JSON.parse(bytes.toString("utf8"));
    } catch {
      return { hidden: [], problem: `${MODEL_VISIBILITY_FILE} 不是有效的 JSON` };
    }
    if (value === null || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => key !== "hiddenModels")) {
      return { hidden: [], problem: `${MODEL_VISIBILITY_FILE} 的最外层应当只有 "hiddenModels" 一项` };
    }
    try {
      return { hidden: normalizeHiddenModels(parseModelRefs((value as { hiddenModels?: unknown }).hiddenModels ?? [], "hiddenModels", "invalid_file")) };
    } catch (error) {
      const entry = error instanceof ProtocolValidationError ? /hiddenModels\[(\d+)\]/u.exec(error.message) : null;
      return {
        hidden: [],
        problem: entry
          ? `${MODEL_VISIBILITY_FILE} 第 ${Number(entry[1]) + 1} 条应当写成 {"provider": "…", "id": "…"}，两项都不能为空`
          : `${MODEL_VISIBILITY_FILE} 的 "hiddenModels" 应当是列表，且隐藏的模型不能太多`,
      };
    }
  }

  /** Replace the whole list; the last save wins. Returns the list exactly as written. */
  write(hidden: readonly ModelRef[]): Promise<ModelRef[]> {
    const next = normalizeHiddenModels(hidden);
    const task = this.writing.then(() => this.replaceFile(next));
    this.writing = task.catch(() => {});
    return task.then(() => next);
  }

  private async replaceFile(hidden: readonly ModelRef[]): Promise<void> {
    const root = resolve(this.stateRoot);
    const temporary = join(root, `.${MODEL_VISIBILITY_FILE}.${process.pid}.${randomUUID()}.tmp`);
    try {
      await mkdir(root, { recursive: true, mode: 0o700 });
      const handle = await open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(formatHiddenModelsFile(hidden), "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await replaceWithRetry(temporary, this.filePath);
      await syncPrivateDirectory(root);
    } catch (error) {
      throw new ModelVisibilityError("model_visibility_write_failed", "隐藏列表没有保存成功，原来的设置不变。请检查这台机器的磁盘空间和 Alu Dock 状态目录的权限，然后再试。", true, { cause: error });
    } finally {
      await rm(temporary, { force: true }).catch(() => {});
    }
  }
}

/** Host-owned model visibility for one machine: the catalog comes from the Agent adapter, the list from this Host. */
export class ModelVisibilityService {
  constructor(private readonly store: ModelVisibilityStore, private readonly catalog: ModelCatalogReader) {}

  /** A hidden model disappears from the list; it can still be selected by its exact provider and id. */
  async filterModelList<T extends ModelList>(list: T): Promise<T> {
    const file = await this.store.read();
    return file.problem === undefined ? withoutHiddenModels(list, file.hidden) : list;
  }

  async get(): Promise<ModelVisibilityResult> {
    const [catalog, file] = await Promise.all([this.readCatalog(), this.store.read()]);
    return { ...catalog, hidden: file.hidden, ...(file.problem === undefined ? {} : { fileProblem: file.problem }) };
  }

  async set(hidden: readonly ModelRef[]): Promise<ModelVisibilitySetResult> {
    return { hidden: await this.store.write(hidden) };
  }

  private async readCatalog(): Promise<ModelList> {
    try {
      return await this.catalog.read();
    } catch (error) {
      throw new ModelVisibilityError("model_catalog_unavailable", "暂时读不到这台机器上可选的模型。请稍后再试；如果一直这样，请在这台机器上新建一个 Work，确认 Pi 能正常启动。", true, { cause: error });
    }
  }
}

export function withoutHiddenModels<T extends ModelList>(list: T, hidden: readonly ModelRef[]): T {
  if (hidden.length === 0) return list;
  const keys = new Set(hidden.map(modelKey));
  const models = list.models.filter((model) => !keys.has(modelKey(model)));
  return { ...list, models, total: list.total - (list.models.length - models.length) };
}

function normalizeHiddenModels(hidden: readonly ModelRef[]): ModelRef[] {
  const unique = new Map(hidden.map((model) => [modelKey(model), { provider: model.provider, id: model.id }]));
  return [...unique.values()].sort((left, right) => left.provider.localeCompare(right.provider) || left.id.localeCompare(right.id));
}

/** One entry per line so a person or Agent can edit the file by hand. */
function formatHiddenModelsFile(hidden: readonly ModelRef[]): string {
  if (hidden.length === 0) return "{\n  \"hiddenModels\": []\n}\n";
  return `{\n  "hiddenModels": [\n${hidden.map((model) => `    ${JSON.stringify({ provider: model.provider, id: model.id })}`).join(",\n")}\n  ]\n}\n`;
}

function modelKey(model: ModelRef): string {
  return `${model.provider}\u0000${model.id}`;
}

async function replaceWithRetry(temporary: string, path: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(temporary, path);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // A reader on Windows can briefly hold the file open while a model list is being filtered.
      if (process.platform !== "win32" || (code !== "EPERM" && code !== "EACCES" && code !== "EBUSY") || attempt >= WINDOWS_REPLACE_RETRY_DELAYS_MS.length) throw error;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, WINDOWS_REPLACE_RETRY_DELAYS_MS[attempt]));
    }
  }
}
