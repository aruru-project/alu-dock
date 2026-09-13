import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";
import { createPiInstance } from "../../src/pi/create-pi-instance.js";

// Card 271: a temporary HOME alone does not isolate the production login-shell
// bootstrap. These runtime tests exercise the existing explicit environment seam.
const root = await mkdtemp(join(tmpdir(), "alu-pi-test-environment-"));
after(() => rm(root, { recursive: true, force: true }));

export function createIsolatedPiInstance(options: Parameters<typeof createPiInstance>[0]): ReturnType<typeof createPiInstance> {
  return createPiInstance({
    ...options,
    agentDir: options.agentDir ?? options.workerEnvironment?.PI_CODING_AGENT_DIR ?? join(root, "pi"),
    workerEnvironment: options.workerEnvironment ?? {
      PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR,
      ComSpec: process.env.ComSpec, PATHEXT: process.env.PATHEXT,
      HOME: root, USERPROFILE: root,
      XDG_CONFIG_HOME: join(root, "config"), XDG_CACHE_HOME: join(root, "cache"),
      XDG_DATA_HOME: join(root, "data"), XDG_STATE_HOME: join(root, "state"), XDG_RUNTIME_DIR: join(root, "run"),
      APPDATA: join(root, "appdata"), LOCALAPPDATA: join(root, "localappdata"),
      PI_CODING_AGENT_DIR: join(root, "pi"), PI_OFFLINE: "1",
      TMPDIR: root, TEMP: root, TMP: root,
    },
  });
}
