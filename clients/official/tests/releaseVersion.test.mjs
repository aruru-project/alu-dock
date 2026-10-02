import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { parseReleaseTag, resolveReleaseVersion } from "../scripts/release-version.mjs";

const repository = mkdtempSync(resolve(tmpdir(), "aludock-release-version-repository-"));
const outsideGit = mkdtempSync(resolve(tmpdir(), "aludock-release-version-source-"));
try {
  assert.deepEqual(parseReleaseTag("v0.2.14-rc.1"), { version: "0.2.14-rc.1", prerelease: true });
  assert.deepEqual(parseReleaseTag("v0.2.14"), { version: "0.2.14", prerelease: false });
  runGit(repository, ["init", "--quiet"]);
  runGit(repository, ["config", "user.name", "Alu Dock Test"]);
  runGit(repository, ["config", "user.email", "test@invalid.example"]);
  writeFileSync(resolve(repository, "source.txt"), "release source\n");
  runGit(repository, ["add", "source.txt"]);
  runGit(repository, ["commit", "--quiet", "-m", "release source"]);
  runGit(repository, ["tag", "v0.2"]);
  runGit(repository, ["tag", "v0.2.5"]);

  assert.equal(
    resolveReleaseVersion({ cwd: repository, fallbackVersion: "0.1.0" }),
    "0.2.5",
    "source packages use the latest reachable release tag",
  );
  assert.equal(
    resolveReleaseVersion({ cwd: repository, explicitVersion: " 1.4.0 ", fallbackVersion: "0.1.0" }),
    "1.4.0",
    "an explicit release version takes precedence",
  );
  assert.equal(
    resolveReleaseVersion({ cwd: repository, explicitVersion: "0.2.14-rc.1", fallbackVersion: "0.1.0" }),
    "0.2.14-rc.1",
    "an RC tag can supply the package version without removing its label",
  );
  runGit(repository, ["tag", "v0.2.14-rc.2"]);
  runGit(repository, ["tag", "v0.2.14-rc.10"]);
  assert.equal(
    resolveReleaseVersion({ cwd: repository, fallbackVersion: "0.1.0" }),
    "0.2.14-rc.10",
    "RC numbers are ordered numerically, not as text",
  );
  runGit(repository, ["tag", "v0.2.14"]);
  assert.equal(
    resolveReleaseVersion({ cwd: repository, fallbackVersion: "0.1.0" }),
    "0.2.14",
    "the final release takes precedence over its RCs",
  );
  runGit(repository, ["tag", "v0.2.15-rc.1"]);
  assert.equal(
    resolveReleaseVersion({ cwd: repository, fallbackVersion: "0.1.0" }),
    "0.2.15-rc.1",
    "an RC for the next version takes precedence over the previous final release",
  );
  assert.equal(
    resolveReleaseVersion({ cwd: outsideGit, fallbackVersion: "0.2.5" }),
    "0.2.5",
    "source archives without Git metadata use their manifest version",
  );
  assert.throws(
    () => resolveReleaseVersion({ cwd: repository, explicitVersion: "v0.2", fallbackVersion: "0.2.5" }),
    /MAJOR\.MINOR\.PATCH/u,
  );
} finally {
  rmSync(repository, { recursive: true, force: true });
  rmSync(outsideGit, { recursive: true, force: true });
}
console.log("release version tests passed");

function runGit(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(" ")} failed`);
}
