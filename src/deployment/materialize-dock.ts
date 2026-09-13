import { chmodSync, copyFileSync, cpSync, mkdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";

import { resolvePiCliEntry } from "../pi/pi-runtime-environment.js";

/** Assemble the application root from Dock's lock, never from an outer npm consumer. */
export function materializeDock(
  projectRoot: string,
  destination: string,
  runNpm: (args: string[], cwd: string) => unknown,
): void {
  rmSync(destination, { recursive: true, force: true });
  mkdirSync(destination, { recursive: true, mode: 0o700 });
  for (const name of ["package.json", "package-lock.json"]) {
    copyFileSync(join(projectRoot, name), join(destination, name));
  }
  runNpm(["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], destination);
  for (const name of ["README.md", "docs", "skills"]) {
    cpSync(join(projectRoot, name), join(destination, name), { recursive: true });
  }
  cpSync(join(projectRoot, "dist", "src"), join(destination, "dist", "src"), { recursive: true });
  const cliPath = realpathSync(join(destination, "dist", "src", "cli.js"));
  if (!/^#!\/usr\/bin\/env node\r?\n/u.test(readFileSync(cliPath, "utf8"))) {
    throw new Error("The built Alu Dock CLI is missing its executable header. Rebuild Dock and try again.");
  }
  // npm ci does not create a .bin entry for the root package itself.
  chmodSync(cliPath, 0o755);
  resolvePiCliEntry(join(destination, "node_modules", "@earendil-works", "pi-coding-agent"));
}
