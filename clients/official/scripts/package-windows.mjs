#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { resolveReleaseVersion } from "./release-version.mjs";

const clientRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const projectRoot = resolve(clientRoot, "..", "..");
const clientManifest = JSON.parse(readFileSync(join(clientRoot, "package.json"), "utf8"));
const dockManifest = JSON.parse(readFileSync(join(projectRoot, "package.json"), "utf8"));
const version = resolveReleaseVersion({
  cwd: projectRoot,
  explicitVersion: process.env.ALUDOCK_RELEASE_VERSION,
  fallbackVersion: clientManifest.version,
});
const packageMode = process.env.ALUDOCK_WINDOWS_PACKAGE_MODE || "full";
if (packageMode !== "full" && packageMode !== "reuse") {
  throw new Error("ALUDOCK_WINDOWS_PACKAGE_MODE must be full or reuse");
}
const windowsBaseArchive = process.env.ALUDOCK_WINDOWS_BASE_ARCHIVE;
if (packageMode === "reuse" && (!windowsBaseArchive || !existsSync(windowsBaseArchive))) {
  throw new Error("A reused Windows package requires ALUDOCK_WINDOWS_BASE_ARCHIVE from a verified formal release");
}
const windowsTarget = "x86_64-pc-windows-msvc";
const nodeRequirement = dockManifest.engines?.node;
const minimumNode = typeof nodeRequirement === "string"
  ? /^>=(\d+)\.(\d+)\.(\d+)$/u.exec(nodeRequirement)
  : undefined;
if (!minimumNode) throw new Error("package.json must declare one minimum supported Node.js version");
// Windows 10/11 inbox contracts only. VC runtimes, WebView loaders, GNU runtimes,
// and other redistributables are deliberately absent and must ship beside their importer.
const AMD64_PE_MACHINE = 0x8664;
const NATIVE_PREBUILD_TARGET = "win32-x64";
const WINDOWS_INBOX_LIBRARIES = new Set([
  "advapi32.dll", "avrt.dll", "bcrypt.dll", "bcryptprimitives.dll", "cfgmgr32.dll",
  "clbcatq.dll", "combase.dll", "comctl32.dll", "comdlg32.dll", "coremessaging.dll",
  "coreuicomponents.dll", "crypt32.dll", "cryptbase.dll", "d2d1.dll", "d3d11.dll",
  "d3dcompiler_47.dll", "dbghelp.dll", "deviceaccess.dll", "dnsapi.dll", "dwmapi.dll",
  "dwrite.dll", "dxcore.dll", "dxgi.dll", "gdi32.dll", "gdiplus.dll", "hid.dll",
  "imagehlp.dll", "imm32.dll", "iphlpapi.dll", "iertutil.dll", "kernel32.dll",
  "kernelbase.dll", "mmdevapi.dll", "mpr.dll", "msacm32.dll", "msasn1.dll", "msctf.dll",
  "msimg32.dll", "msvcrt.dll", "mswsock.dll", "ncrypt.dll", "netapi32.dll", "normaliz.dll",
  "ntasn1.dll", "ntdll.dll", "ole32.dll", "oleacc.dll", "oleaut32.dll", "powrprof.dll",
  "profapi.dll", "propsys.dll", "psapi.dll", "rasapi32.dll", "rpcrt4.dll", "sechost.dll",
  "secur32.dll", "setupapi.dll", "shell32.dll", "shlwapi.dll", "srvcli.dll", "sspicli.dll",
  "ucrtbase.dll", "urlmon.dll", "user32.dll", "userenv.dll", "usp10.dll", "uxtheme.dll",
  "version.dll", "wevtapi.dll", "windowscodecs.dll", "winhttp.dll", "wininet.dll",
  "winmm.dll", "winspool.drv", "wintrust.dll", "winusb.dll", "win32u.dll", "wldap32.dll",
  "ws2_32.dll", "wtsapi32.dll",
]);

if (process.platform !== "win32" || process.arch !== "x64") {
  throw new Error("Windows package assembly must run on native x86_64 Windows.");
}
const systemTar = windowsSystemExecutable("tar.exe");
const releaseName = `AluDock-${version}-windows-x86_64`;
const defaultOutputDirectory = join(clientRoot, "dist");
const configuredOutput = process.env.ALUDOCK_WINDOWS_OUTPUT;
const output = configuredOutput ? resolve(configuredOutput) : join(defaultOutputDirectory, `${releaseName}-Setup.exe`);
// Keep resource paths on the backend volume and short enough for makensis.
// Product/version identity belongs in the manifest and outer artifact name,
// not in every deeply nested dependency's temporary source path.
const temporary = mkdtempSync(join(projectRoot, ".aluw-"));
const releaseRoot = join(temporary, "r");

try {
  mkdirSync(releaseRoot, { recursive: true });
  // Internal component archive is a build input, not an installation entrypoint.
  const payloadRoot = join(releaseRoot, "app");
  if (packageMode === "reuse") {
    reuseWindowsPayload(resolve(windowsBaseArchive), payloadRoot, temporary, systemTar);
  } else {
    mkdirSync(payloadRoot, { recursive: true });
  }
  const buildRuntime = hostNodeRuntime();

  runNpm(buildRuntime, ["run", "build"], projectRoot);
  if (packageMode === "full") buildDesktop(version, windowsTarget, buildRuntime);
  materializeDock(join(payloadRoot, "dock"), buildRuntime);
  if (packageMode === "full") copyDesktop(payloadRoot, windowsTarget);
  rmSync(join(payloadRoot, "runtime"), { recursive: true, force: true });
  pruneNonTargetNativePrebuilds(payloadRoot);
  copyFileSync(join(clientRoot, "LICENSE-APACHE"), join(payloadRoot, "LICENSE-APACHE"));
  const supportRoot = join(payloadRoot, "support");
  rmSync(supportRoot, { recursive: true, force: true });
  mkdirSync(supportRoot, { recursive: true });
  copyFileSync(join(clientRoot, "scripts", "windows-package.ps1"), join(supportRoot, "windows-package.ps1"));
  writeFileSync(join(payloadRoot, "aludock.cmd"), renderLauncher(), "utf8");
  rmSync(join(payloadRoot, "Uninstall.cmd"), { force: true });
  rmSync(join(payloadRoot, "Uninstall.exe"), { force: true });
  rmSync(join(payloadRoot, "release-manifest.json"), { force: true });
  writeFileSync(join(payloadRoot, "release-manifest.json"), `${JSON.stringify({
    schemaVersion: 2,
    productVersion: version,
    target: windowsTarget,
    dockVersion: dockManifest.version,
    nodeRequirement,
    desktop: "AluDock.exe",
    cli: "aludock.cmd",
    files: collectFiles(payloadRoot).map((path) => ({ path: relative(payloadRoot, path).replaceAll("\\", "/"), sha256: sha256File(path) })),
  }, null, 2)}\n`, "utf8");

  inspectRelease(releaseRoot);
  mkdirSync(dirname(output), { recursive: true });
  rmSync(output, { force: true });
  const components = output.replace(/-Setup\.exe$/iu, "-components.zip");
  if (components === output) throw new Error("ALUDOCK_WINDOWS_OUTPUT must end in -Setup.exe");
  run(systemTar, ["-a", "-c", "-f", components, basename(releaseRoot)], { cwd: temporary });
  const requiredPaths = ["AluDock.exe", "aludock.cmd", "release-manifest.json", "dock/dist/src/cli.js", "dock/dist/src/deployment/windows-host-bootstrap.js", "support/windows-package.ps1"]
    .map((path) => `${basename(releaseRoot)}/app/${path}`);
  const listing = new Set(run(systemTar, ["-t", "-f", components, ...requiredPaths], { capture: true }).stdout.replaceAll("\\", "/").split(/\r?\n/u).map((path) => path.trim()));
  for (const path of requiredPaths) if (!listing.has(path)) throw new Error(`The component archive is missing ${path}`);
  // tauri bundle (not build) also works when reusing a verified Desktop binary.
  const targetDirectory = join(clientRoot, "src-tauri", "target", windowsTarget, "release");
  mkdirSync(targetDirectory, { recursive: true });
  copyFileSync(join(payloadRoot, "AluDock.exe"), join(targetDirectory, "aludock-client-app.exe"));
  const tauriCli = join(clientRoot, "node_modules", "@tauri-apps", "cli", "tauri.js");
  run(buildRuntime.nodePath, [tauriCli, "bundle", "--bundles", "nsis", "--target", windowsTarget,
    "--config", JSON.stringify({ version, bundle: { resources: { [relative(join(clientRoot, "src-tauri"), payloadRoot).replaceAll("\\", "/")]: "payload/" }, windows: {
      nsis: { template: "../scripts/windows-installer.nsi", installMode: "currentUser" },
      webviewInstallMode: { type: "embedBootstrapper", silent: true },
    } } }),
  ], { cwd: clientRoot, env: runtimeEnvironment(buildRuntime.nodePath) });
  const bundles = collectFiles(join(targetDirectory, "bundle", "nsis")).filter((path) => path.endsWith("-setup.exe"));
  const bundle = bundles.find((path) => basename(path).includes(version));
  if (!bundle) throw new Error("Tauri did not produce the requested Setup.exe");
  copyFileSync(bundle, output);
  assertAmd64(join(payloadRoot, "AluDock.exe"));
  console.log(`Windows package: ${output}`);
  console.log(`SHA-256: ${sha256File(output)}`);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}

function reuseWindowsPayload(archive, destination, workspace, tarPath) {
  const extracted = join(workspace, "windows-base");
  mkdirSync(extracted, { recursive: true });
  run(tarPath, ["-x", "-f", archive, "-C", extracted]);
  const roots = readdirSync(extracted, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  if (roots.length !== 1) throw new Error("The verified Windows base package must contain one release directory");
  const source = join(extracted, roots[0].name, "app");
  for (const required of ["AluDock.exe", "aludock.cmd", join("dock", "dist", "src", "cli.js")]) {
    if (!existsSync(join(source, required))) throw new Error(`The verified Windows base package is missing app/${required}`);
  }
  const manifest = JSON.parse(readFileSync(join(source, "release-manifest.json"), "utf8"));
  if (manifest?.target !== windowsTarget || manifest?.schemaVersion !== 2) {
    throw new Error("The reusable components must contain the gate-aware Windows x64 Desktop; build a full package first");
  }
  cpSync(source, destination, { recursive: true });
}

function hostNodeRuntime() {
  const npmCliPath = join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
  if (!existsSync(npmCliPath)) {
    throw new Error(`The Node.js installation does not include npm-cli.js: ${npmCliPath}`);
  }
  return { nodePath: process.execPath, npmCliPath };
}

function buildDesktop(productVersion, rustTarget, runtime) {
  const tauriCli = join(clientRoot, "node_modules", "@tauri-apps", "cli", "tauri.js");
  if (!existsSync(tauriCli)) {
    throw new Error("The Tauri CLI is missing. Run npm run client:install from the repository root, then try again.");
  }
  run(runtime.nodePath, [
    tauriCli, "build", "--no-bundle", "--ci", "--target", rustTarget,
    "--config", JSON.stringify({ version: productVersion }),
  ], { cwd: clientRoot, env: runtimeEnvironment(runtime.nodePath) });
}

function materializeDock(destination, runtime) {
  rmSync(destination, { recursive: true, force: true });
  mkdirSync(destination, { recursive: true });
  for (const name of ["package.json", "package-lock.json"]) {
    copyFileSync(join(projectRoot, name), join(destination, name));
  }
  runNpm(runtime, ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], destination);
  for (const name of ["README.md", "docs", "skills"]) {
    cpSync(join(projectRoot, name), join(destination, name), { recursive: true });
  }
  cpSync(join(projectRoot, "dist", "src"), join(destination, "dist", "src"), { recursive: true });
  const bundledPi = join(destination, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js");
  if (!existsSync(bundledPi)) throw new Error("The production Dock tree does not contain bundled Pi");
}

function copyDesktop(destination, rustTarget) {
  const targetDirectory = join(clientRoot, "src-tauri", "target", rustTarget, "release");
  const executable = join(targetDirectory, "aludock-client-app.exe");
  if (!existsSync(executable)) throw new Error(`Tauri build did not produce ${executable}`);
  copyFileSync(executable, join(destination, "AluDock.exe"));
  for (const entry of readdirSync(targetDirectory, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.toLowerCase().endsWith(".dll")) {
      copyFileSync(join(targetDirectory, entry.name), join(destination, entry.name));
    }
  }
}

function pruneNonTargetNativePrebuilds(root) {
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const path = join(directory, entry.name);
      if (entry.name.toLowerCase() !== "prebuilds") {
        visit(path);
        continue;
      }
      for (const prebuild of readdirSync(path, { withFileTypes: true })) {
        if (!prebuild.isDirectory()) continue;
        const prebuildPath = join(path, prebuild.name);
        if (prebuild.name.toLowerCase() !== NATIVE_PREBUILD_TARGET) {
          rmSync(prebuildPath, { recursive: true, force: true });
        } else {
          visit(prebuildPath);
        }
      }
    }
  };
  visit(root);
}

function inspectRelease(root) {
  const binaries = collectFiles(root).filter((path) =>
    /\.(?:exe|dll)$/iu.test(path) || (/\.node$/iu.test(path) && peMachine(path) !== undefined));
  if (binaries.length === 0) throw new Error("Windows release contains no PE binaries");
  const dumpbin = findExecutable("dumpbin.exe");
  if (!dumpbin) throw new Error("Run package:windows from a Visual Studio Developer terminal so dumpbin.exe can inspect DLL dependencies.");
  for (const binary of binaries) {
    assertAmd64(binary);
    const report = run(dumpbin, ["/dependents", binary], { capture: true }).stdout;
    const imports = [...report.matchAll(/^\s+([A-Za-z0-9_.-]+\.(?:dll|drv))\s*$/gimu)].map((match) => match[1]);
    for (const imported of imports) {
      const normalized = imported.toLowerCase();
      if (/^(?:api|ext)-ms-/u.test(normalized) || WINDOWS_INBOX_LIBRARIES.has(normalized)) continue;
      const available = [dirname(binary), root]
        .some((directory) => existsCaseInsensitive(directory, imported));
      if (!available) {
        throw new Error(`${relative(root, binary)} imports ${imported}, which is neither a supported Windows inbox library nor a packaged sidecar`);
      }
    }
  }
}

function assertAmd64(path) {
  if (peMachine(path) !== AMD64_PE_MACHINE) throw new Error(`${path} is not an AMD64 Windows binary`);
}

function peMachine(path) {
  const data = readFileSync(path);
  if (data.length < 0x40 || data.readUInt16LE(0) !== 0x5a4d) return undefined;
  const header = data.readUInt32LE(0x3c);
  if (header + 6 > data.length || data.readUInt32LE(header) !== 0x00004550) return undefined;
  return data.readUInt16LE(header + 4);
}

function existsCaseInsensitive(directory, name) {
  if (!existsSync(directory) || !statSync(directory).isDirectory()) return false;
  const expected = name.toLowerCase();
  return readdirSync(directory).some((entry) => entry.toLowerCase() === expected);
}

function collectFiles(root) {
  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) files.push(path);
    }
  };
  visit(root);
  return files;
}

function renderLauncher() {
  const [, major, minor, patch] = minimumNode;
  const compatibilityCheck = `const v=process.versions.node.split('.').map(Number);process.exit(process.arch==='x64'&&(v[0]>${major}||(v[0]===${major}&&(v[1]>${minor}||(v[1]===${minor}&&v[2]>=${patch}))))?0:1)`;
  return "@REM Generated by Alu Dock package; do not edit in place.\r\n"
    + "@ECHO OFF\r\n"
    + "@SETLOCAL\r\n"
    + "@SET \"ALUDOCK_ROOT=%~dp0\"\r\n"
    + "@SET \"ALUDOCK_NODE=\"\r\n"
    + "@IF DEFINED ALUDOCK_NODE_PATH CALL :try_node \"%ALUDOCK_NODE_PATH%\"\r\n"
    + "@IF NOT DEFINED ALUDOCK_NODE CALL :try_node \"%ProgramFiles%\\nodejs\\node.exe\"\r\n"
    + "@IF NOT DEFINED ALUDOCK_NODE CALL :try_node \"%LOCALAPPDATA%\\Programs\\nodejs\\node.exe\"\r\n"
    + "@IF NOT DEFINED ALUDOCK_NODE FOR /F \"delims=\" %%N IN ('WHERE node.exe 2^>NUL') DO @IF NOT DEFINED ALUDOCK_NODE CALL :try_node \"%%N\"\r\n"
    + "@IF DEFINED ALUDOCK_NODE GOTO node_ready\r\n"
    + `@ECHO Alu Dock needs 64-bit Node.js ${major}.${minor}.${patch} or newer. Install or update it from https://nodejs.org/ and run Setup.exe again. 1>&2\r\n`
    + "@EXIT /B 1\r\n"
    + ":node_ready\r\n"
    + "@FOR %%D IN (\"%ALUDOCK_NODE%\") DO @SET \"PATH=%%~dpD;%PATH%\"\r\n"
    + "@\"%ALUDOCK_NODE%\" \"%ALUDOCK_ROOT%dock\\dist\\src\\cli.js\" %*\r\n"
    + "@EXIT /B %ERRORLEVEL%\r\n"
    + ":try_node\r\n"
    + "@IF NOT EXIST \"%~1\" EXIT /B 0\r\n"
    + `@"%~1" -e "${compatibilityCheck}" >NUL 2>NUL\r\n`
    + "@IF NOT ERRORLEVEL 1 SET \"ALUDOCK_NODE=%~1\"\r\n"
    + "@EXIT /B 0\r\n";
}

function findExecutable(name) {
  const result = spawnSync(windowsSystemExecutable("where.exe"), [name], { encoding: "utf8" });
  if (result.status !== 0) return undefined;
  return result.stdout.split(/\r?\n/u).map((line) => line.trim()).find(Boolean);
}

function windowsSystemExecutable(name) {
  const systemRoot = process.env.SystemRoot || process.env.WINDIR;
  if (!systemRoot) throw new Error(`Windows did not provide SystemRoot while locating ${name}`);
  const executable = join(systemRoot, "System32", name);
  if (!existsSync(executable)) throw new Error(`Required Windows system tool is missing: ${executable}`);
  return executable;
}

function runNpm(runtime, args, cwd) {
  return run(runtime.nodePath, [runtime.npmCliPath, ...args], {
    cwd,
    env: runtimeEnvironment(runtime.nodePath),
  });
}

function runtimeEnvironment(nodePath) {
  const environment = { ...process.env };
  const inheritedPathKey = Object.keys(environment).find((key) => key.toLowerCase() === "path");
  const inheritedPath = inheritedPathKey ? environment[inheritedPathKey] || "" : "";
  for (const key of Object.keys(environment)) {
    if (key.toLowerCase() === "path") delete environment[key];
  }
  environment.Path = inheritedPath ? `${dirname(nodePath)};${inheritedPath}` : dirname(nodePath);
  return environment;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? clientRoot,
    encoding: "utf8",
    env: options.env ?? process.env,
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  if (result.error) throw result.error;
  if (result.signal) throw new Error(`${command} was interrupted by ${result.signal}`);
  if (result.status !== 0) {
    throw new Error(`${basename(command)} failed (${result.status ?? "unknown"}): ${(result.stderr || result.stdout || "").slice(-4_000)}`);
  }
  return { stdout: result.stdout || "", stderr: result.stderr || "" };
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}
