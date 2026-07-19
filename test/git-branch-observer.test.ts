import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { GitBranchObserver } from "../src/pi/git-branch-observer.js";

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<void> {
  await execFileAsync("git", ["-C", cwd, ...args], { timeout: 5_000, maxBuffer: 64 * 1_024 });
}

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 4_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(message);
}

test("Git branch observer tracks normal, detached, and disposed workspace state", async () => {
  const root = await mkdtemp(join(tmpdir(), "alu-git-observer-"));
  try {
    await git(root, "init", "--initial-branch=main");
    await git(root, "config", "user.email", "alu@example.invalid");
    await git(root, "config", "user.name", "Alu Test");
    await writeFile(join(root, "README.md"), "hello\n", "utf8");
    await git(root, "add", "README.md");
    await git(root, "commit", "-m", "initial");

    const changes: Array<string | undefined> = [];
    const observer = await GitBranchObserver.create(root, (branch) => changes.push(branch), { debounceMs: 20 });
    assert.equal(observer.branch, "main");

    await git(root, "switch", "-c", "feature/observer");
    await waitFor(() => observer.branch === "feature/observer", "branch switch was not observed");
    assert.equal(changes.at(-1), "feature/observer");

    await git(root, "switch", "--detach", "HEAD");
    await waitFor(() => observer.branch === "detached", "detached HEAD was not observed");
    assert.equal(changes.at(-1), "detached");

    observer.dispose();
    const countAfterDispose = changes.length;
    await git(root, "switch", "main");
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(changes.length, countAfterDispose, "disposed observers must fence stale filesystem callbacks");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Git branch observer resolves worktrees and discovers repositories created after startup", async () => {
  const root = await mkdtemp(join(tmpdir(), "alu-git-worktree-"));
  const worktree = join(root, "linked");
  const repository = join(root, "repository");
  const outside = join(root, "outside");
  try {
    await Promise.all([
      mkdir(repository, { recursive: true }),
      mkdir(outside, { recursive: true }),
    ]);
    await git(repository, "init", "--initial-branch=main");
    await git(repository, "config", "user.email", "alu@example.invalid");
    await git(repository, "config", "user.name", "Alu Test");
    await writeFile(join(repository, "file.txt"), "one\n", "utf8");
    await git(repository, "add", "file.txt");
    await git(repository, "commit", "-m", "initial");
    await git(repository, "worktree", "add", "-b", "worktree-start", worktree);

    const changes: Array<string | undefined> = [];
    const observer = await GitBranchObserver.create(worktree, (branch) => changes.push(branch), { debounceMs: 20 });
    assert.equal(observer.branch, "worktree-start");
    await git(worktree, "switch", "-c", "worktree-next");
    await waitFor(() => observer.branch === "worktree-next", "linked-worktree HEAD change was not observed");
    observer.dispose();

    const outsideChanges: Array<string | undefined> = [];
    const nonRepository = await GitBranchObserver.create(outside, (branch) => outsideChanges.push(branch), { debounceMs: 20 });
    assert.equal(nonRepository.branch, undefined);
    await git(outside, "init", "--initial-branch=main");
    await waitFor(() => nonRepository.branch === "main", "repository creation was not observed");
    assert.deepEqual(outsideChanges, ["main"]);
    nonRepository.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
