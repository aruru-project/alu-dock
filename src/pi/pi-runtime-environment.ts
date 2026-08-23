import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PI_PACKAGE_NAME = "@earendil-works/pi-coding-agent";
const PI_PACKAGE_DIR_ENV = "PI_PACKAGE_DIR";
const PI_RUNTIME_NODE_ENV = "ALU_DOCK_PI_NODE";
let runtimeBin: string | undefined;

export function piWorkerRuntimeEnvironment(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const packageDir = loadedPiPackageDir();
  realpathSync(join(packageDir, "dist", "cli.js"));
  const environment = { ...base };
  const pathKey = Object.keys(environment).find((key) => key.toLowerCase() === "path") ?? "PATH";
  for (const key of Object.keys(environment)) {
    if (key.toLowerCase() === "path" && key !== pathKey) delete environment[key];
  }
  environment[pathKey] = [ensureRuntimeBin(), environment[pathKey]].filter(Boolean).join(delimiter);
  environment[PI_PACKAGE_DIR_ENV] = packageDir;
  environment[PI_RUNTIME_NODE_ENV] = process.execPath;
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
  process.argv[1] = realpathSync(join(packageDir, "dist", "cli.js"));
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

function ensureRuntimeBin(): string {
  if (runtimeBin) return runtimeBin;
  const directory = mkdtempSync(join(tmpdir(), "alu-dock-pi-runtime-"));
  try {
    chmodSync(directory, 0o700);
    writeFileSync(join(directory, "pi"), "#!/bin/sh\nexec \"$ALU_DOCK_PI_NODE\" \"$PI_PACKAGE_DIR/dist/cli.js\" \"$@\"\n", { mode: 0o700 });
    if (process.platform === "win32") {
      writeFileSync(join(directory, "pi.cmd"), "@echo off\r\n\"%ALU_DOCK_PI_NODE%\" \"%PI_PACKAGE_DIR%\\dist\\cli.js\" %*\r\nexit /b %ERRORLEVEL%\r\n");
      writeFileSync(join(directory, "pi.ps1"), "& $env:ALU_DOCK_PI_NODE (Join-Path $env:PI_PACKAGE_DIR 'dist\\cli.js') @args\r\nexit $LASTEXITCODE\r\n");
    }
  } catch (error) {
    try { rmSync(directory, { recursive: true, force: true }); } catch {}
    throw error;
  }
  runtimeBin = directory;
  process.once("exit", () => { try { rmSync(directory, { recursive: true, force: true }); } catch {} });
  return directory;
}
