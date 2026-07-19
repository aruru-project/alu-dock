import { watch, type FSWatcher } from "node:fs";
import { stat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";

const GIT_TIMEOUT_MS = 2_000;
const GIT_OUTPUT_LIMIT = 16_384;
const BRANCH_LIMIT = 256;
const WATCH_DEBOUNCE_MS = 80;
const RECOVERY_RETRY_MS = 250;
const MAX_RECOVERY_RETRIES = 3;

export interface GitBranchObserverPort {
  readonly branch: string | undefined;
  dispose(): void;
}

export interface GitBranchObserverOptions {
  debounceMs?: number;
  commandTimeoutMs?: number;
}

interface GitLayout {
  gitDir: string;
  commonDir: string;
}

interface GitResult {
  code: number | null;
  stdout: string;
  overflow: boolean;
}

interface BranchRead {
  ok: boolean;
  branch?: string;
}

interface LayoutRead {
  ok: boolean;
  layout?: GitLayout;
}

/**
 * Host-owned, shell-free Git branch cache. Filesystem notifications only
 * invalidate the cache; every projected value is re-read through bounded Git
 * subprocesses so worktrees, packed refs, and reftable repositories share the
 * same semantics.
 */
export class GitBranchObserver implements GitBranchObserverPort {
  private branchValue: string | undefined;
  private layout: GitLayout | undefined;
  private readonly watchers: FSWatcher[] = [];
  private readonly children = new Set<ChildProcess>();
  private timer: NodeJS.Timeout | undefined;
  private recoveryAttempts = 0;
  private disposed = false;
  private refreshGeneration = 0;

  private constructor(
    private readonly cwd: string,
    private readonly onChange: (branch: string | undefined) => void,
    private readonly options: GitBranchObserverOptions,
  ) {}

  static async create(
    cwd: string,
    onChange: (branch: string | undefined) => void,
    options: GitBranchObserverOptions = {},
  ): Promise<GitBranchObserver> {
    const observer = new GitBranchObserver(cwd, onChange, options);
    await observer.refresh(false);
    return observer;
  }

  get branch(): string | undefined { return this.branchValue; }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.refreshGeneration += 1;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    for (const watcher of this.watchers.splice(0)) watcher.close();
    for (const child of this.children) child.kill("SIGKILL");
    this.children.clear();
  }

  private scheduleRefresh(): void {
    if (this.disposed) return;
    this.refreshGeneration += 1;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.refresh(true);
    }, this.options.debounceMs ?? WATCH_DEBOUNCE_MS);
    this.timer.unref?.();
  }

  private async refresh(notify: boolean): Promise<void> {
    const generation = ++this.refreshGeneration;
    const layoutRead = await this.readLayout();
    if (this.disposed || generation !== this.refreshGeneration) return;
    if (!layoutRead.ok) {
      this.scheduleRecovery();
      return;
    }
    const layout = layoutRead.layout;

    if (!sameLayout(layout, this.layout) || this.watchers.length === 0) {
      this.layout = layout;
      await this.replaceWatchers(layout);
      if (this.disposed || generation !== this.refreshGeneration) return;
    }

    const branchRead: BranchRead = layout ? await this.readBranch() : { ok: true };
    if (this.disposed || generation !== this.refreshGeneration) return;
    if (!branchRead.ok) {
      this.scheduleRecovery();
      return;
    }
    this.recoveryAttempts = 0;
    if (branchRead.branch === this.branchValue) return;
    this.branchValue = branchRead.branch;
    if (notify) this.onChange(branchRead.branch);
  }

  private scheduleRecovery(): void {
    if (this.disposed || this.timer || this.recoveryAttempts >= MAX_RECOVERY_RETRIES) return;
    this.recoveryAttempts += 1;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.refresh(true);
    }, RECOVERY_RETRY_MS * this.recoveryAttempts);
    this.timer.unref?.();
  }

  private async readLayout(): Promise<LayoutRead> {
    const gitDirResult = await this.runGit(["rev-parse", "--path-format=absolute", "--git-dir"]);
    if (gitDirResult.overflow || gitDirResult.code === null) return { ok: false };
    if (gitDirResult.code !== 0) return { ok: gitDirResult.code === 128 };
    const commonDirResult = await this.runGit(["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    if (commonDirResult.overflow || commonDirResult.code === null) return { ok: false };
    if (commonDirResult.code !== 0) return { ok: commonDirResult.code === 128 };
    const gitDir = safeGitPath(gitDirResult.stdout, this.cwd);
    const commonDir = safeGitPath(commonDirResult.stdout, this.cwd);
    return gitDir && commonDir ? { ok: true, layout: { gitDir, commonDir } } : { ok: false };
  }

  private async readBranch(): Promise<BranchRead> {
    const result = await this.runGit(["symbolic-ref", "--quiet", "--short", "HEAD"]);
    if (result.overflow) return { ok: false };
    if (result.code === 1) return { ok: true, branch: "detached" };
    if (result.code !== 0) return { ok: false };
    const branch = safeBranch(result.stdout);
    return branch === undefined ? { ok: false } : { ok: true, branch };
  }

  private async replaceWatchers(layout: GitLayout | undefined): Promise<void> {
    for (const watcher of this.watchers.splice(0)) watcher.close();
    if (this.disposed) return;
    if (!layout) {
      try {
        const watcher = watch(this.cwd, { persistent: false }, (_eventType, filename) => {
          if (filename === null || filename.toString() === ".git") this.scheduleRefresh();
        });
        watcher.on("error", () => {
          const index = this.watchers.indexOf(watcher);
          if (index >= 0) this.watchers.splice(index, 1);
          watcher.close();
          this.scheduleRecovery();
        });
        this.watchers.push(watcher);
      } catch {
        this.scheduleRecovery();
      }
      return;
    }

    const targets = new Set([
      layout.gitDir,
      layout.commonDir,
      join(layout.gitDir, "HEAD"),
      join(layout.commonDir, "HEAD"),
      join(layout.gitDir, "refs"),
      join(layout.commonDir, "refs"),
      join(layout.gitDir, "refs", "heads"),
      join(layout.commonDir, "refs", "heads"),
      join(layout.gitDir, "reftable"),
      join(layout.commonDir, "reftable"),
      join(layout.gitDir, "packed-refs"),
      join(layout.commonDir, "packed-refs"),
    ]);

    for (const target of targets) {
      if (this.disposed || !await exists(target)) continue;
      try {
        const watcher = watch(target, { persistent: false }, () => this.scheduleRefresh());
        watcher.on("error", () => {
          this.layout = undefined;
          this.scheduleRefresh();
        });
        this.watchers.push(watcher);
      } catch {
        // The containing Git directory remains watched; a later invalidation
        // rebuilds paths that were replaced atomically between stat and watch.
      }
    }
  }

  private runGit(args: readonly string[]): Promise<GitResult> {
    if (this.disposed) return Promise.resolve({ code: null, stdout: "", overflow: false });
    return new Promise((resolveResult) => {
      const child = spawn("git", ["-C", this.cwd, ...args], {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      this.children.add(child);
      const chunks: Buffer[] = [];
      let size = 0;
      let overflow = false;
      let settled = false;
      const timeout = setTimeout(() => {
        child.kill("SIGKILL");
        finish(null);
      }, this.options.commandTimeoutMs ?? GIT_TIMEOUT_MS);
      timeout.unref?.();

      const finish = (code: number | null): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        this.children.delete(child);
        resolveResult({ code, stdout: Buffer.concat(chunks).toString("utf8"), overflow });
      };

      child.stdout.on("data", (chunk: Buffer) => {
        if (overflow) return;
        size += chunk.length;
        if (size > GIT_OUTPUT_LIMIT) {
          overflow = true;
          child.kill("SIGKILL");
          return;
        }
        chunks.push(chunk);
      });
      child.stderr.resume();
      child.on("error", () => finish(null));
      child.on("close", (code) => finish(code));
    });
  }
}

function safeGitPath(output: string, cwd: string): string | undefined {
  const value = trimSingleLine(output);
  if (!value) return undefined;
  const path = isAbsolute(value) ? value : resolve(cwd, value);
  return path.length <= 16_384 ? path : undefined;
}

function safeBranch(output: string): string | undefined {
  const value = trimSingleLine(output);
  if (!value || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) return undefined;
  if (value.length <= BRANCH_LIMIT) return value;
  const end = /[\uD800-\uDBFF]/u.test(value[BRANCH_LIMIT - 2] ?? "") ? BRANCH_LIMIT - 2 : BRANCH_LIMIT - 1;
  return `${value.slice(0, Math.max(0, end))}…`;
}

function trimSingleLine(output: string): string | undefined {
  const value = output.endsWith("\n") ? output.slice(0, -1) : output;
  const normalized = value.endsWith("\r") ? value.slice(0, -1) : value;
  return normalized.includes("\n") || normalized.includes("\r") ? undefined : normalized;
}

function sameLayout(left: GitLayout | undefined, right: GitLayout | undefined): boolean {
  return left?.gitDir === right?.gitDir && left?.commonDir === right?.commonDir;
}

async function exists(path: string): Promise<boolean> {
  try { await stat(path); return true; } catch { return false; }
}
