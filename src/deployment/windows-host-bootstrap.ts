// This entry deliberately imports no Host, catalog, settings or Pi code before ownership.
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { WindowsHostLifecycleServer } from "./windows-host-lifecycle.js";

const lifecycle = new WindowsHostLifecycleServer();
const ownerPath = join(process.env.LOCALAPPDATA ?? "", "Alu Dock", "host-owner.json");
const stop = (): void => lifecycle.beginStop();
let owned = false;
try {
  await lifecycle.start();
  owned = true;
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  await mkdir(dirname(ownerPath), { recursive: true });
  await writeFile(ownerPath, JSON.stringify({ pid: process.pid, exited: false }), "utf8");
  if (!lifecycle.stopRequested) {
    const { runWindowsHost } = await import("../cli.js");
    if (!lifecycle.stopRequested) await runWindowsHost(lifecycle);
  }
} catch (error) {
  process.stderr.write(`Alu Dock could not start. Check the Host log and retry: ${String(error)}\n`);
  process.exitCode = 1;
} finally {
  if (owned) {
    lifecycle.beginStop();
    await writeFile(ownerPath, JSON.stringify({ pid: process.pid, exited: true }), "utf8").catch(() => {});
    await lifecycle.stop();
  }
  process.off("SIGINT", stop);
  process.off("SIGTERM", stop);
}
