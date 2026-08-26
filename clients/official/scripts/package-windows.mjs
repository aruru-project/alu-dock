#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  copyFileSync,
  cpSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const clientRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const projectRoot = resolve(clientRoot, "..", "..");
const clientManifest = JSON.parse(readFileSync(join(clientRoot, "package.json"), "utf8"));
const dockManifest = JSON.parse(readFileSync(join(projectRoot, "package.json"), "utf8"));
const runtimeManifest = JSON.parse(readFileSync(join(clientRoot, "windows-runtime.json"), "utf8"));
const version = (process.env.ALUDOCK_RELEASE_VERSION || clientManifest.version).trim();
// Windows 10/11 inbox contracts only. VC runtimes, WebView loaders, GNU runtimes,
// and other redistributables are deliberately absent and must ship beside their importer.
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
if (!/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u.test(version)) {
  throw new Error(`Release version must use MAJOR.MINOR.PATCH: ${version}`);
}
validateRuntimeManifest(runtimeManifest);

const target = runtimeManifest.target;
const releaseName = `AluDock-${version}-windows-x86_64`;
const outputDirectory = join(clientRoot, "dist");
const output = join(outputDirectory, `${releaseName}.zip`);
const temporary = mkdtempSync(join(tmpdir(), "aludock-windows-package-"));
const releaseRoot = join(temporary, releaseName);

try {
  runNpm(["run", "build"], projectRoot);
  buildDesktop(version, target);

  mkdirSync(releaseRoot, { recursive: true });
  materializeDock(join(releaseRoot, "dock"));
  await materializeNode(join(releaseRoot, "runtime"), temporary, runtimeManifest.node);
  copyDesktop(releaseRoot, target);
  copyFileSync(join(clientRoot, "LICENSE-APACHE"), join(releaseRoot, "LICENSE-APACHE"));
  writeFileSync(join(releaseRoot, "aludock.cmd"), renderLauncher(), "utf8");
  writeFileSync(join(releaseRoot, "Setup.cmd"), renderSetup(), "utf8");
  writeFileSync(join(releaseRoot, "release-manifest.json"), `${JSON.stringify({
    schemaVersion: 1,
    productVersion: version,
    target,
    dockVersion: dockManifest.version,
    node: runtimeManifest.node,
    desktop: "AluDock.exe",
    cli: "aludock.cmd",
  }, null, 2)}\n`, "utf8");

  inspectRelease(releaseRoot);
  mkdirSync(outputDirectory, { recursive: true });
  rmSync(output, { force: true });
  run("tar.exe", ["-a", "-c", "-f", output, releaseName], { cwd: temporary });
  const listing = run("tar.exe", ["-t", "-f", output], { capture: true }).stdout;
  for (const required of ["AluDock.exe", "Setup.cmd", "aludock.cmd", "runtime/node.exe", "runtime/npm.cmd", "dock/dist/src/cli.js"]) {
    if (!listing.replaceAll("\\", "/").includes(`${releaseName}/${required}`)) {
      throw new Error(`Final archive is missing ${required}`);
    }
  }
  console.log(`Windows package: ${output}`);
  console.log(`SHA-256: ${sha256File(output)}`);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}

function validateRuntimeManifest(manifest) {
  if (manifest?.schemaVersion !== 1 || manifest.target !== "x86_64-pc-windows-msvc") {
    throw new Error("windows-runtime.json must describe the supported Windows x64 MSVC target");
  }
  const node = manifest.node;
  if (!node || !/^\d+\.\d+\.\d+$/u.test(node.version)
    || !/^\d+\.\d+\.\d+$/u.test(node.npmVersion)
    || node.archive !== `node-v${node.version}-win-x64.zip`
    || !/^[a-f0-9]{64}$/u.test(node.sha256)) {
    throw new Error("windows-runtime.json contains invalid Node release metadata");
  }
}

function buildDesktop(productVersion, rustTarget) {
  const arguments_ = [
    "exec", "tauri", "build", "--no-bundle", "--ci", "--target", rustTarget,
    "--config", JSON.stringify({ version: productVersion }),
  ];
  run("corepack.cmd", ["pnpm", ...arguments_], { cwd: clientRoot });
}

function materializeDock(destination) {
  mkdirSync(destination, { recursive: true });
  for (const name of ["package.json", "package-lock.json"]) {
    copyFileSync(join(projectRoot, name), join(destination, name));
  }
  runNpm(["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], destination);
  for (const name of ["README.md", "docs", "skills"]) {
    cpSync(join(projectRoot, name), join(destination, name), { recursive: true });
  }
  cpSync(join(projectRoot, "dist", "src"), join(destination, "dist", "src"), { recursive: true });
  const bundledPi = join(destination, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js");
  if (!existsSync(bundledPi)) throw new Error("The production Dock tree does not contain bundled Pi");
}

async function materializeNode(destination, workspace, node) {
  const configuredArchive = process.env.ALUDOCK_WINDOWS_NODE_ARCHIVE;
  const archive = configuredArchive ? resolve(configuredArchive) : join(workspace, node.archive);
  if (!configuredArchive) await download(`https://nodejs.org/dist/v${node.version}/${node.archive}`, archive);
  if (!existsSync(archive) || sha256File(archive) !== node.sha256) {
    throw new Error(`Node archive checksum does not match windows-runtime.json: ${archive}`);
  }
  const extracted = join(workspace, "node-extracted");
  mkdirSync(extracted, { recursive: true });
  run("tar.exe", ["-x", "-f", archive, "-C", extracted]);
  const source = join(extracted, `node-v${node.version}-win-x64`);
  for (const required of ["node.exe", "npm.cmd", "npx.cmd", join("node_modules", "npm", "bin", "npm-cli.js")]) {
    if (!existsSync(join(source, required))) throw new Error(`Official Node archive is missing ${required}`);
  }
  const npmVersion = run(join(source, "node.exe"), [join(source, "node_modules", "npm", "bin", "npm-cli.js"), "--version"], { capture: true }).stdout.trim();
  if (npmVersion !== node.npmVersion) {
    throw new Error(`Official Node archive contains npm ${npmVersion}; expected ${node.npmVersion}`);
  }
  cpSync(source, destination, { recursive: true });
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

function inspectRelease(root) {
  const dumpbin = findExecutable("dumpbin.exe");
  if (!dumpbin) throw new Error("Run package:windows from a Visual Studio Developer terminal so dumpbin.exe can inspect DLL dependencies.");
  const binaries = collectFiles(root).filter((path) => /\.(?:exe|dll|node)$/iu.test(path));
  if (binaries.length === 0) throw new Error("Windows release contains no PE binaries");
  for (const binary of binaries) {
    assertAmd64(binary);
    const report = run(dumpbin, ["/dependents", binary], { capture: true }).stdout;
    const imports = [...report.matchAll(/^\s+([A-Za-z0-9_.-]+\.(?:dll|drv))\s*$/gimu)].map((match) => match[1]);
    for (const imported of imports) {
      const normalized = imported.toLowerCase();
      if (/^(?:api|ext)-ms-/u.test(normalized) || WINDOWS_INBOX_LIBRARIES.has(normalized)) continue;
      const available = [dirname(binary), root, join(root, "runtime")]
        .some((directory) => existsCaseInsensitive(directory, imported));
      if (!available) {
        throw new Error(`${relative(root, binary)} imports ${imported}, which is neither a supported Windows inbox library nor a packaged sidecar`);
      }
    }
  }
}

function assertAmd64(path) {
  const data = readFileSync(path);
  if (data.length < 0x40 || data.readUInt16LE(0) !== 0x5a4d) throw new Error(`${path} is not a PE file`);
  const header = data.readUInt32LE(0x3c);
  if (header + 6 > data.length || data.readUInt32LE(header) !== 0x00004550 || data.readUInt16LE(header + 4) !== 0x8664) {
    throw new Error(`${path} is not an AMD64 Windows binary`);
  }
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
  return "@REM Generated by Alu Dock package; do not edit in place.\r\n"
    + "@ECHO OFF\r\n"
    + "@SET \"ALUDOCK_ROOT=%~dp0\"\r\n"
    + "@SET \"PATH=%ALUDOCK_ROOT%runtime;%PATH%\"\r\n"
    + "@\"%ALUDOCK_ROOT%runtime\\node.exe\" \"%ALUDOCK_ROOT%dock\\dist\\src\\cli.js\" %*\r\n";
}

function renderSetup() {
  return `@ECHO OFF\r
@SETLOCAL\r
@SET "SOURCE=%~dp0"\r
@IF NOT DEFINED LOCALAPPDATA (ECHO Alu Dock could not locate your local application directory.& EXIT /B 1)\r
@SET "DEST=%LOCALAPPDATA%\\Alu Dock\\app"\r
@SET "NEXT=%LOCALAPPDATA%\\Alu Dock\\app.next"\r
@SET "PREVIOUS=%LOCALAPPDATA%\\Alu Dock\\app.previous"\r
@CALL "%SOURCE%aludock.cmd" service stop --json >NUL\r
@IF ERRORLEVEL 1 (ECHO Finish or stop active Work, then run Setup.cmd again.& EXIT /B 1)\r
@IF /I "%SOURCE%"=="%DEST%\\" GOTO INSTALL\r
@IF EXIST "%NEXT%" RMDIR /S /Q "%NEXT%"\r
@MKDIR "%NEXT%"\r
@ROBOCOPY "%SOURCE%" "%NEXT%" /MIR /R:2 /W:1 /NFL /NDL /NJH /NJS /NP >NUL\r
@IF ERRORLEVEL 8 (ECHO Alu Dock could not copy the package. Keep the extracted files and try again.& EXIT /B 1)\r
@IF EXIST "%PREVIOUS%" RMDIR /S /Q "%PREVIOUS%"\r
@IF EXIST "%DEST%" (MOVE "%DEST%" "%PREVIOUS%" >NUL& IF ERRORLEVEL 1 (ECHO Exit the existing Desktop, then run Setup.cmd again.& EXIT /B 1))\r
@MOVE "%NEXT%" "%DEST%" >NUL\r
@IF ERRORLEVEL 1 (IF EXIST "%PREVIOUS%" MOVE "%PREVIOUS%" "%DEST%" >NUL& ECHO Alu Dock could not activate the new package. Try again.& EXIT /B 1)\r
:INSTALL\r
@CALL "%DEST%\\aludock.cmd" service install --now --json >NUL\r
@IF ERRORLEVEL 1 (ECHO Alu Dock was copied, but it did not finish starting. Open the Host log and try again.& EXIT /B 1)\r
@START "" "%DEST%\\AluDock.exe"\r
@ECHO Alu Dock is ready.\r
@EXIT /B 0\r
`;
}

async function download(url, destination) {
  const response = await fetch(url, { headers: { "User-Agent": "AluDock-Windows-Packager" } });
  if (!response.ok || !response.body) throw new Error(`Node download returned HTTP ${response.status}`);
  try {
    await pipeline(Readable.fromWeb(response.body), createWriteStream(destination, { flags: "wx" }));
  } catch (error) {
    rmSync(destination, { force: true });
    throw error;
  }
}

function findExecutable(name) {
  const result = spawnSync("where.exe", [name], { encoding: "utf8" });
  if (result.status !== 0) return undefined;
  return result.stdout.split(/\r?\n/u).map((line) => line.trim()).find(Boolean);
}

function runNpm(args, cwd) {
  const npmCli = process.env.npm_execpath;
  if (npmCli && /npm-cli\.js$/iu.test(npmCli)) return run(process.execPath, [npmCli, ...args], { cwd });
  if (npmCli && /npm\.cmd$/iu.test(npmCli)) return run(npmCli, args, { cwd });
  return run("npm.cmd", args, { cwd });
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? clientRoot,
    encoding: "utf8",
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
