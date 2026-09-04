import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PI_PACKAGE_NAME = "@earendil-works/pi-coding-agent";
const PI_PACKAGE_DIR_ENV = "PI_PACKAGE_DIR";
const PI_CLI_ENTRY_ENV = "ALU_DOCK_PI_CLI_ENTRY";
const PI_RUNTIME_NODE_ENV = "ALU_DOCK_PI_NODE";
const ALU_DOCK_CLI_ENV = "ALU_DOCK_CLI_ENTRY";
let runtimeBin: string | undefined;

export function piWorkerRuntimeEnvironment(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const packageDir = loadedPiPackageDir();
  const cliEntry = loadedPiCliEntry(packageDir);
  const environment = { ...base };
  const pathKey = Object.keys(environment).find((key) => key.toLowerCase() === "path") ?? "PATH";
  for (const key of Object.keys(environment)) {
    if (key.toLowerCase() === "path" && key !== pathKey) delete environment[key];
  }
  environment[pathKey] = [ensureRuntimeBin(), environment[pathKey]].filter(Boolean).join(delimiter);
  environment[PI_PACKAGE_DIR_ENV] = packageDir;
  environment[PI_CLI_ENTRY_ENV] = cliEntry;
  environment[PI_RUNTIME_NODE_ENV] = process.execPath;
  environment[ALU_DOCK_CLI_ENV] = realpathSync(fileURLToPath(new URL("../cli.js", import.meta.url)));
  environment.PI_CODING_AGENT = "true";
  environment.AI_AGENT = "pi";
  return environment;
}

export function enterPiWorkerRuntime(): void {
  const packageDir = process.env[PI_PACKAGE_DIR_ENV];
  if (!packageDir) throw new Error("Pi Worker runtime package is unavailable");
  const runtimeNode = process.env[PI_RUNTIME_NODE_ENV];
  if (!runtimeNode || realpathSync(runtimeNode) !== realpathSync(process.execPath)) {
    throw new Error("Pi Worker runtime executable changed before startup");
  }
  const cliEntry = process.env[PI_CLI_ENTRY_ENV];
  if (!cliEntry || realpathSync(cliEntry) !== loadedPiCliEntry(packageDir)) {
    throw new Error("Pi Worker CLI entry changed before startup");
  }
  process.argv[1] = realpathSync(cliEntry);
}

function loadedPiPackageDir(): string {
  let directory = dirname(realpathSync(fileURLToPath(import.meta.resolve(PI_PACKAGE_NAME))));
  while (directory !== dirname(directory)) {
    try {
      const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8")) as { name?: unknown };
      if (manifest.name === PI_PACKAGE_NAME) return directory;
    } catch { /* Continue to the owning package. */ }
    directory = dirname(directory);
  }
  throw new Error("Loaded Pi runtime package could not be identified");
}

function loadedPiCliEntry(packageDir: string): string {
  const manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")) as { bin?: unknown };
  const entry = typeof manifest.bin === "string"
    ? manifest.bin
    : manifest.bin && typeof manifest.bin === "object" && typeof (manifest.bin as { pi?: unknown }).pi === "string"
      ? (manifest.bin as { pi: string }).pi
      : undefined;
  if (!entry) throw new Error("Loaded Pi runtime package does not declare its CLI entry");
  return realpathSync(join(packageDir, entry));
}

function ensureRuntimeBin(): string {
  if (runtimeBin) return runtimeBin;
  const directory = mkdtempSync(join(tmpdir(), "alu-dock-pi-runtime-"));
  try {
    chmodSync(directory, 0o700);
    writeFileSync(join(directory, "pi"), "#!/bin/sh\nexec \"$ALU_DOCK_PI_NODE\" \"$ALU_DOCK_PI_CLI_ENTRY\" \"$@\"\n", { mode: 0o700 });
    writeFileSync(join(directory, "aludock"), "#!/bin/sh\nexec \"$ALU_DOCK_PI_NODE\" \"$ALU_DOCK_CLI_ENTRY\" \"$@\"\n", { mode: 0o700 });
    if (process.platform === "win32") {
      writeFileSync(join(directory, "pi.cmd"), "@echo off\r\n\"%ALU_DOCK_PI_NODE%\" \"%ALU_DOCK_PI_CLI_ENTRY%\" %*\r\nexit /b %ERRORLEVEL%\r\n");
      writeFileSync(join(directory, "pi.ps1"), "& $env:ALU_DOCK_PI_NODE $env:ALU_DOCK_PI_CLI_ENTRY @args\r\nexit $LASTEXITCODE\r\n");
      writeFileSync(join(directory, "aludock.cmd"), "@echo off\r\n\"%ALU_DOCK_PI_NODE%\" \"%ALU_DOCK_CLI_ENTRY%\" %*\r\nexit /b %ERRORLEVEL%\r\n");
      writeFileSync(join(directory, "aludock.ps1"), "& $env:ALU_DOCK_PI_NODE $env:ALU_DOCK_CLI_ENTRY @args\r\nexit $LASTEXITCODE\r\n");
    }
  } catch (error) {
    try { rmSync(directory, { recursive: true, force: true }); } catch {}
    throw error;
  }
  runtimeBin = directory;
  process.once("exit", () => { try { rmSync(directory, { recursive: true, force: true }); } catch {} });
  return directory;
}
