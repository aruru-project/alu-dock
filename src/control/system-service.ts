import { createHash, randomUUID } from "node:crypto";
import { link, lstat, mkdir, open, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { JsonObject } from "../core/json-value.js";
import { readResourceContent, ResourceContentError } from "../core/resource-content.js";
import { ProtocolValidationError, type SystemCandidate, type SystemCatalogResult, type SystemCatalogCursor, type SystemSourceKind, type SystemDefaultSetResult } from "./protocol.js";

export const MAX_SYSTEM_CATALOG_ITEMS = 100;
export const MAX_SYSTEM_CATALOG_PAGE_BYTES = 128 * 1_024;

export interface SystemSource { kind: SystemSourceKind; path: string }
/** Agent semantics are injected at composition time; Host never interprets workerConfig. */
export interface SystemTemplateProvider {
  nativeSources(cwd: string): SystemSource[];
  initialTemplate(): string;
  validate(source: SystemSource, text: string): void;
  workerConfig(source: SystemSource): JsonObject;
}

export class SystemService {
  private initialization?: Promise<void>;
  private readonly systemsPath: string;
  constructor(home: string, private readonly provider: SystemTemplateProvider) {
    this.systemsPath = join(home, ".aludock", "systems");
  }

  private async initialize(): Promise<void> {
    await mkdir(dirname(this.systemsPath), { recursive: true });
    // The marker lives outside systems so deleting that directory cannot revive a saved target.
    const marker = join(dirname(this.systemsPath), "systems-initialized");
    try { await lstat(marker); return; }
    catch (error) { if (errorCode(error) !== "ENOENT") throw error; }
    await mkdir(this.systemsPath, { recursive: true });
    const path = join(this.systemsPath, "pi-default.json");
    let exists = true;
    try { await lstat(path); }
    catch (error) { if (errorCode(error) !== "ENOENT") throw error; exists = false; }
    if (!exists) {
      const text = this.provider.initialTemplate();
      const temporary = `${path}.${randomUUID()}.tmp`;
      const handle = await open(temporary, "wx", 0o600);
      try {
        try { await handle.writeFile(text); await handle.sync(); }
        finally { await handle.close(); }
        // Publish only complete bytes, without overwriting a user file created meanwhile.
        try { await link(temporary, path); }
        catch (error) { if (errorCode(error) !== "EEXIST") throw error; }
      } finally { await rm(temporary, { force: true }); }
    }
    // Existing prose is never replaced. An incomplete/unusable target must not record success.
    this.provider.validate({ kind: "dock-template", path }, await readAll(path));
    try { await writeFile(marker, "\n", { flag: "wx", mode: 0o600 }); }
    catch (error) { if (errorCode(error) !== "EEXIST") throw error; }
  }

  private async directory(cwd: string): Promise<string> {
    try {
      const path = await realpath(cwd);
      if (!(await stat(path)).isDirectory()) throw new Error();
      return path;
    } catch { throw new ProtocolValidationError("workspace_unavailable", "无法打开这个工作目录。请检查目录和读取权限后重选。"); }
  }

  private async sources(cwd: string, validate = true): Promise<{ candidates: SystemCandidate[]; warnings: string[] }> {
    const warnings: string[] = [];
    try { await (this.initialization ??= this.initialize()); }
    catch { this.initialization = undefined; warnings.push("无法初始化 system 模板目录。请检查 Home 下 .aludock 的写入权限后重试。"); }
    const sources = this.provider.nativeSources(cwd);
    try {
      const names = (await readdir(this.systemsPath)).filter((name) => name.endsWith(".json")).sort();
      sources.push(...names.map((name): SystemSource => ({ kind: "dock-template", path: join(this.systemsPath, name) })));
    } catch { warnings.push("无法列出 Dock system 模板。请检查 Home 下 .aludock/systems 的读取权限后重试。"); }
    const candidates: SystemCandidate[] = [];
    for (const source of sources) {
      try { await stat(source.path); }
      catch (error) { if (errorCode(error) === "ENOENT" && source.kind !== "dock-template") continue; }
      const candidate: SystemCandidate = {
        id: createHash("sha256").update(JSON.stringify([cwd, source.kind, source.path])).digest("hex"),
        name: basename(source.path), kind: source.kind, path: source.path,
        workerConfig: this.provider.workerConfig(source),
      };
      if (validate) {
        try { this.provider.validate(source, await readAll(source.path)); }
        catch { candidate.warning = `无法使用 ${source.path}。请检查文件内容及读取权限，或选择另一份 system。`; }
      }
      candidates.push(candidate);
    }
    return { candidates, warnings };
  }

  async catalog(cwd: string, cursor?: SystemCatalogCursor, limit = MAX_SYSTEM_CATALOG_ITEMS): Promise<SystemCatalogResult> {
    cwd = await this.directory(cwd);
    const { candidates, warnings } = await this.sources(cwd);
    let defaultSelection: SystemCandidate | undefined;
    try {
      const saved: unknown = JSON.parse(await readAll(join(cwd, ".aludock", "system-default.json")));
      if (saved === null || typeof saved !== "object" || Object.keys(saved).length !== 1 || typeof (saved as { id?: unknown }).id !== "string") throw new Error();
      defaultSelection = candidates.find((item) => item.id === (saved as { id: string }).id && !item.warning);
      if (!defaultSelection) throw new Error();
    } catch {
      // readAll deliberately uses the same reader as previews; distinguish absent config here.
      try { await lstat(join(cwd, ".aludock", "system-default.json")); }
      catch (statError) { if (errorCode(statError) === "ENOENT") return this.page(cwd, candidates, warnings, cursor, limit); }
      warnings.push("本目录保存的 system 无法使用。请重新选择；需要时再明确保存目录默认。");
    }
    return this.page(cwd, candidates, warnings, cursor, limit, defaultSelection);
  }

  private page(cwd: string, candidates: SystemCandidate[], warnings: string[], cursor: SystemCatalogCursor | undefined, limit: number, defaultSelection?: SystemCandidate): SystemCatalogResult {
    const revision = createHash("sha256").update(JSON.stringify(candidates)).digest("hex");
    const offset = cursor?.offset ?? 0;
    if (cursor && (cursor.revision !== revision || offset >= candidates.length)) throw new ProtocolValidationError("resource_unavailable", "system 列表已变化。请重新打开选择列表。");
    const page: SystemCandidate[] = [];
    let bytes = Buffer.byteLength(JSON.stringify({ warnings, defaultSelection }));
    for (const candidate of candidates.slice(offset, offset + limit)) {
      const size = Buffer.byteLength(JSON.stringify(candidate));
      if (page.length && bytes + size > MAX_SYSTEM_CATALOG_PAGE_BYTES) break;
      page.push(candidate); bytes += size;
    }
    const next = offset + page.length;
    return { cwd, candidates: page, total: candidates.length, revision, warnings,
      ...(defaultSelection ? { defaultSelection } : {}),
      ...(next < candidates.length ? { nextCursor: { revision, offset: next } } : {}),
    };
  }

  private async selected(cwd: string, id: string, validate = true): Promise<SystemCandidate> {
    const { candidates } = await this.sources(cwd, false);
    const candidate = candidates.find((item) => item.id === id);
    if (!candidate) throw new ResourceContentError("这份 system 已不在候选列表中。请重新打开列表选择。");
    if (validate) {
      try { this.provider.validate(candidate, await readAll(candidate.path)); }
      catch { throw new ResourceContentError(`无法使用 ${candidate.path}。请检查文件内容及读取权限，或选择另一份 system。`); }
    }
    return candidate;
  }

  async content(cwd: string, id: string, offset?: number, revision?: string) {
    const candidate = await this.selected(await this.directory(cwd), id, false);
    return readResourceContent(candidate.path, offset, revision);
  }

  async setDefault(cwd: string, id: string): Promise<SystemDefaultSetResult> {
    cwd = await this.directory(cwd);
    const selection = await this.selected(cwd, id);
    const path = join(cwd, ".aludock", "system-default.json");
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await mkdir(dirname(path), { recursive: true });
      const handle = await open(temporary, "wx", 0o600);
      try { await handle.writeFile(JSON.stringify({ id }) + "\n"); await handle.sync(); }
      finally { await handle.close(); }
      await rename(temporary, path);
    } catch { throw new ProtocolValidationError("system_default_unavailable", "无法保存本目录的 system 选择。请检查 .aludock 的写入权限后重试；本次仍可单独选择。"); }
    finally { await rm(temporary, { force: true }).catch(() => {}); }
    return { selection };
  }
}

async function readAll(path: string): Promise<string> {
  let text = "", offset: number | undefined, revision: string | undefined;
  do {
    const page = await readResourceContent(path, offset, revision);
    text += page.text; offset = page.nextOffset; revision = page.revision;
  } while (offset !== undefined);
  return text;
}
function errorCode(error: unknown): string | undefined { return (error as NodeJS.ErrnoException)?.code; }
