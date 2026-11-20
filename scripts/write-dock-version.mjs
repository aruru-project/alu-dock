import { writeFileSync } from "node:fs";
import { resolveReleaseVersion } from "../clients/official/scripts/release-version.mjs";

const version = resolveReleaseVersion();
writeFileSync(new URL("../dist/src/dock-release-version.js", import.meta.url), `export const DOCK_VERSION = ${JSON.stringify(version)};\n`);
console.log(`Alu Dock ${version}`);
