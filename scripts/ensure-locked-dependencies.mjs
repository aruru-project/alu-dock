// install:local builds the checkout before installing it. When the installed
// dependencies no longer match package-lock.json (for example after pulling a new
// Pi release), refresh them with npm ci first; otherwise do nothing.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const locked = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8")).packages ?? {};
// npm's own record of what it installed into node_modules.
const installedRecord = join(root, "node_modules", ".package-lock.json");
const installed = existsSync(installedRecord) ? JSON.parse(readFileSync(installedRecord, "utf8")).packages ?? {} : {};

const stale = Object.entries(locked).some(([path, entry]) => {
  if (!path.startsWith("node_modules/")) return false;
  const current = installed[path];
  // npm leaves out optional packages meant for other platforms.
  if (current === undefined) return entry.optional !== true;
  return current.version !== entry.version || current.resolved !== entry.resolved || current.integrity !== entry.integrity;
});

if (stale) {
  const npm = process.env.npm_execpath;
  if (!npm) {
    console.error("Dependencies differ from package-lock.json. Run npm ci, or start this through npm run install:local.");
    process.exit(1);
  }
  console.log("Dependencies differ from package-lock.json; running npm ci before building.");
  const result = spawnSync(process.execPath, [npm, "ci"], { cwd: root, stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
