import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { copyStagedPackage, installUserExecutable } from "../scripts/install-local.js";

import {
  ALU_DOCK_GENERATED_MARKER,
  assertLocalInstallAllowed,
  isAluDockGeneratedContent,
  localInstallBlockingInstances,
  localInstallInspectionMayAssumeHostAbsent,
  localInstallLayout,
  parseLocalInstallArguments,
  renderAluDockUnit,
} from "../src/deployment/local-install.js";

test("package exposes the installed Alu Dock runtime and its operator/client documentation", async () => {
  const manifest = JSON.parse(await readFile(join(process.cwd(), "package.json"), "utf8")) as {
    bin?: unknown;
    files?: unknown;
    scripts?: Record<string, string>;
  };
  assert.deepEqual(manifest.bin, { aludock: "dist/src/cli.js" });
  assert.deepEqual(manifest.files, ["dist/src", "docs", "skills", "README.md"]);
  assert.equal(manifest.scripts?.["install:local"], "npm run build && node dist/scripts/install-local.js");
  assert.doesNotMatch(manifest.scripts?.["install:local"] ?? "", /\btest\b/u);
});

test("Windows release has one complete package entry and uses the user's compatible Node.js", async () => {
  const rootManifest = JSON.parse(await readFile(join(process.cwd(), "package.json"), "utf8")) as {
    scripts?: Record<string, string>;
    engines?: { node?: unknown };
  };
  const clientManifest = JSON.parse(await readFile(join(process.cwd(), "clients", "official", "package.json"), "utf8")) as { scripts?: Record<string, string> };
  const packager = await readFile(join(process.cwd(), "clients", "official", "scripts", "package-windows.mjs"), "utf8");

  assert.equal(rootManifest.scripts?.["package:windows"], "cd clients/official && corepack pnpm package:windows");
  assert.equal(clientManifest.scripts?.["package:windows"], "node scripts/package-windows.mjs");
  assert.equal(rootManifest.scripts?.["host:windows"], undefined);
  assert.equal(rootManifest.scripts?.["open:windows"], undefined);
  assert.match(String(rootManifest.engines?.node), /^>=\d+\.\d+\.\d+$/u);
  assert.match(packager, /const releaseName = `AluDock-\$\{version\}-windows-x86_64`/u);
  assert.doesNotMatch(packager, /windows-runtime|nodejs\.org\/dist|materializeNode/u);
});

test("npm package excludes tests, fixtures, and development scripts", () => {
  const result = spawnSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout) as Array<{ files?: Array<{ path?: string }> }>;
  const paths = report[0]?.files?.map((file) => file.path).filter((path): path is string => typeof path === "string") ?? [];
  assert.ok(paths.includes("dist/src/cli.js"));
  assert.ok(paths.includes("package.json"));
  assert.ok(paths.includes("skills/dock-attachments/SKILL.md"));
  assert.ok(paths.includes("docs/agent/dock-tools.md"));
  assert.ok(paths.every((path) => path === "package.json" || path === "README.md" || path.startsWith("dist/src/") || path.startsWith("docs/") || path.startsWith("skills/")), paths.join("\n"));
  assert.equal(paths.some((path) => path.startsWith("dist/test/") || path.startsWith("dist/scripts/") || path.startsWith("test/")), false);
});

test("local install uses the locked application root and its executable CLI", () => {
  assert.deepEqual(localInstallLayout("/home/tester"), {
    root: "/home/tester/.local/share/alu-dock",
    packageDirectory: "/home/tester/.local/share/alu-dock/dock",
    cliPath: "/home/tester/.local/share/alu-dock/dock/dist/src/cli.js",
    packageExecutable: "/home/tester/.local/share/alu-dock/dock/dist/src/cli.js",
    userExecutable: "/home/tester/.local/bin/aludock",
    unitFile: "/home/tester/.config/systemd/user/alu-dock.service",
  });
});

test("Linux launcher replaces the former npm entry, runs the application CLI, and protects user files", { skip: process.platform === "win32" }, async (context) => {
  const home = await mkdtemp(join(tmpdir(), "alu-install-launcher-"));
  context.after(() => rm(home, { recursive: true, force: true }));
  const layout = localInstallLayout(home, undefined, { platform: "linux" });
  await mkdir(join(layout.packageDirectory, "dist", "src"), { recursive: true });
  await mkdir(join(home, ".local", "bin"), { recursive: true });
  await writeFile(layout.cliPath, '#!/usr/bin/env node\nconsole.log(JSON.stringify(process.argv.slice(2)));\n');
  await chmod(layout.cliPath, 0o755);
  await symlink(join(layout.root, "node_modules", ".bin", "aludock"), layout.userExecutable);
  await installUserExecutable(layout.userExecutable, layout.packageExecutable, home, layout.root);
  assert.equal(await readlink(layout.userExecutable), layout.cliPath);
  const result = spawnSync(layout.userExecutable, ["argument with spaces"], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH, HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: join(home, "pi"),
      XDG_CONFIG_HOME: join(home, "config"), XDG_CACHE_HOME: join(home, "cache"),
      XDG_DATA_HOME: join(home, "data"), XDG_STATE_HOME: join(home, "state"),
      TMPDIR: home, TEMP: home, TMP: home,
    },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), ["argument with spaces"]);
  await rm(layout.userExecutable);
  await writeFile(layout.userExecutable, "user-owned launcher\n");
  // User-owned executable paths are an explicit arbitrary-file overwrite boundary.
  await assert.rejects(installUserExecutable(layout.userExecutable, layout.packageExecutable, home, layout.root));
  assert.equal(await readFile(layout.userExecutable, "utf8"), "user-owned launcher\n");
  await rm(layout.userExecutable);
  await symlink(join(home, "my-launcher"), layout.userExecutable);
  await assert.rejects(installUserExecutable(layout.userExecutable, layout.packageExecutable, home, layout.root));
  assert.equal(await readlink(layout.userExecutable), join(home, "my-launcher"));
});

test("Windows package uses one stable app directory and bundled terminal entry", () => {
  assert.deepEqual(localInstallLayout("C:\\Users\\artist", undefined, {
    platform: "win32",
    localAppData: "C:\\Users\\artist\\AppData\\Local",
  }), {
    root: "C:\\Users\\artist\\AppData\\Local\\AluDock",
    packageDirectory: "C:\\Users\\artist\\AppData\\Local\\AluDock\\dock",
    cliPath: "C:\\Users\\artist\\AppData\\Local\\AluDock\\dock\\dist\\src\\cli.js",
    packageExecutable: "C:\\Users\\artist\\AppData\\Local\\AluDock\\aludock.cmd",
    userExecutable: "C:\\Users\\artist\\AppData\\Local\\AluDock\\aludock.cmd",
    unitFile: "C:\\Users\\artist\\AppData\\Local\\AluDock\\dock\\dist\\src\\cli.js",
    windowsHostLogPath: "C:\\Users\\artist\\AppData\\Local\\Alu Dock\\logs\\host.log",
  });
});

test("local install ignores quiescent instances and identifies only active work", () => {
  const instances = [
    { id: "idle", lifecycle: "active", execution: "idle" },
    { id: "settled-failure", lifecycle: "active", execution: "failed" },
    { id: "stopped", lifecycle: "stopped", execution: "unavailable" },
    { id: "running", lifecycle: "active", execution: "running" },
    { id: "interaction", lifecycle: "active", execution: "idle", activeInteraction: { id: "dialog" } },
    { id: "queued", lifecycle: "active", execution: "idle", pending: { total: 1 } },
    { id: "stopping", lifecycle: "stopping", execution: "running" },
  ] as const;
  assert.deepEqual(localInstallBlockingInstances(instances).map((instance) => instance.id), [
    "running", "interaction", "queued", "stopping",
  ]);
  assert.doesNotThrow(() => assertLocalInstallAllowed(instances.slice(0, 3)));
});

test("local install fails closed after reaching the Host during admission", () => {
  assert.equal(localInstallInspectionMayAssumeHostAbsent(false, "connection_error"), true);
  assert.equal(localInstallInspectionMayAssumeHostAbsent(true, "connection_error"), false);
  assert.equal(localInstallInspectionMayAssumeHostAbsent(false, "connection_closed"), false);
  assert.equal(localInstallInspectionMayAssumeHostAbsent(false, "timeout"), false);
});

test("local install explains the explicit active-work replacement override", () => {
  const instances = [
    { id: "active-id", name: "active-name", lifecycle: "active", execution: "running" },
    { id: "stopping-id", lifecycle: "stopping", execution: "running" },
  ] as const;
  let message = "";
  assert.throws(() => assertLocalInstallAllowed(instances), (error: unknown) => {
    assert.ok(error instanceof Error);
    message = error.message;
    return true;
  });
  assert.match(message, /active-name \(responding\).*Unnamed work \(finishing\).*npm run install:local -- --replace-active.*interrupts current responses/su);
  assert.doesNotMatch(message, /active-id|stopping-id/u);
  assert.doesNotThrow(() => assertLocalInstallAllowed(instances, true));
  assert.deepEqual(parseLocalInstallArguments([]), { replaceActive: false });
  assert.deepEqual(parseLocalInstallArguments(["--replace-active"]), { replaceActive: true });
  assert.throws(() => parseLocalInstallArguments(["--allow-active"]), /Unknown local install option.*--replace-active/u);
});

test("generated ownership distinguishes the managed unit from a user unit", () => {
  assert.equal(isAluDockGeneratedContent(`${ALU_DOCK_GENERATED_MARKER}\n[Unit]\n`), true);
  assert.equal(isAluDockGeneratedContent("# hand-written\n[Unit]\n"), false);
});

test("generated user unit runs the fixed installed CLI with private state", () => {
  const unit = renderAluDockUnit({
    nodePath: "/opt/node/bin/node",
    cliPath: "/home/tester/.local/share/alu-dock/dock/dist/src/cli.js",
    homePath: "/home/tester",
  });
  for (const expected of [
    ALU_DOCK_GENERATED_MARKER,
    "Type=exec",
    'ExecStart="/opt/node/bin/node" "/home/tester/.local/share/alu-dock/dock/dist/src/cli.js" serve --managed',
    "Environment=ALU_DOCK_MANAGED=1",
    'Environment="HOME=/home/tester"',
    'Environment="PATH=/opt/node/bin:/home/tester/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"',
    "Restart=on-failure",
    "OOMPolicy=continue",
    "MemoryMax=20G",
    "MemorySwapMax=0",
    "RuntimeDirectory=alu-dock",
    "RuntimeDirectoryMode=0700",
    "StateDirectory=alu-dock",
    "StateDirectoryMode=0700",
    "WorkingDirectory=%h",
    "UMask=0077",
    "StandardOutput=journal",
  ]) assert.match(unit, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")));
  assert.doesNotMatch(unit, /(?:GEM_HOME|GEM_PATH|MY_RUBY_HOME|RUBY_VERSION|NVM_DIR|node_modules\/.bin|alu-kanban\/env)/u);
  assert.match(renderAluDockUnit({ nodePath: "/opt/node%pin/bin/node", cliPath: "/srv/alu%dock/cli.js", homePath: "/home/tester" }), /node%%pin.*alu%%dock/u);
  assert.throws(
    () => renderAluDockUnit({ nodePath: "/opt/node:evil/bin/node", cliPath: "/srv/alu/cli.js", homePath: "/home/tester" }),
    /cannot contain colons/u,
  );
});

// Card 271 installation review: Node24 cp rewrote .bin symlinks into deleted staging paths.
test("final package executables survive deleting the staging directory", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "alu-final-copy-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const stage = join(root, "staging"), final = join(root, "installed");
  await mkdir(join(stage, "node_modules", ".bin"), { recursive: true });
  await mkdir(join(stage, "node_modules", "pi"));
  await writeFile(join(stage, "node_modules", "pi", "cli.js"), "#!/usr/bin/env node\nconsole.log('fixture Pi executable');\n", { mode: 0o755 });
  await symlink("../pi/cli.js", join(stage, "node_modules", ".bin", "pi"));
  await copyStagedPackage(stage, final);
  await rm(stage, { recursive: true, force: true });
  assert.equal(await readlink(join(final, "node_modules", ".bin", "pi")), "../pi/cli.js");
  const result = spawnSync(join(final, "node_modules", ".bin", "pi"), [], { encoding: "utf8", env: { PATH: process.env.PATH, HOME: root, XDG_CONFIG_HOME: root, XDG_CACHE_HOME: root, XDG_STATE_HOME: root, XDG_DATA_HOME: root } });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /fixture Pi executable/u);
});
