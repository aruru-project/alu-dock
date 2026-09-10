// #270: the native launcher exited but its caller waited for Host lifetime,
// keeping Setup locked. Exercise the packaged entry with a harmless child.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

assert.equal(process.platform, "win32", "Run the native launch smoke on Windows");
const executable = resolve(process.argv[2]);
const root = await mkdtemp(join(tmpdir(), "aludock-launch-"));
const stop = join(root, "stop");
await mkdir(join(root, "logs"));
const script = join(root, "child.mjs");
await writeFile(script, `import { existsSync } from 'node:fs';
const timer = setInterval(() => { if (existsSync(${JSON.stringify(stop)})) clearInterval(timer); }, 50);
setTimeout(() => process.exit(1), 30000).unref();\n`);
let pid;
let timer;
try {
  const child = spawn(executable, ["--launch-host", process.execPath, script, join(root, "logs", "child.log")], {
    windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, HOME: root, USERPROFILE: root, LOCALAPPDATA: root, APPDATA: root },
  });
  let stdout = "", stderr = "";
  child.stdout.on("data", (data) => { stdout += data; pid = Number(stdout.trim()); });
  child.stderr.on("data", (data) => { stderr += data; });
  const closed = new Promise((resolveClose, reject) => {
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolveClose() : reject(new Error(stderr || `Launcher exit ${code}`)));
  });
  await Promise.race([closed, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("Launcher reply stayed open for the background child's lifetime")), 10000);
  })]);
  assert.ok(Number.isSafeInteger(pid) && pid > 0, "Launcher must report the actual background child");
  process.kill(pid, 0); // The reply must close while the child is still alive.
  console.log("PASS: native launcher returns with its background child still alive.");
} finally {
  clearTimeout(timer);
  await writeFile(stop, "stop");
  if (Number.isSafeInteger(pid) && pid > 0) {
    for (let i = 0; i < 100; i++) {
      try { process.kill(pid, 0); } catch { break; }
      await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    }
  }
  await rm(root, { recursive: true, force: true });
}
