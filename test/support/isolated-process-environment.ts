import { join } from "node:path";

const INHERITED_KEYS = ["PATH", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "TMPDIR", "TEMP", "TMP", "SystemRoot", "WINDIR", "ComSpec", "PATHEXT"] as const;

/**
 * Card #351: a Host child started from `...process.env` inside a Dock-managed Pi
 * inherited that Pi's real `PI_CODING_AGENT_DIR`, Worker identity and exported
 * credentials. Child Hosts, CLI commands and TUI clients start from this short
 * list instead, with every user directory under the test's own home.
 *
 * This does not isolate a Pi Worker that a CLI-started Host creates: the Worker
 * environment comes from the system account's login shell. Such Workers need
 * `workerEnvironment` (see docs/qa.md).
 */
export function isolatedProcessEnvironment(home: string, overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_CACHE_HOME: join(home, ".cache"),
    XDG_STATE_HOME: join(home, ".local", "state"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    APPDATA: join(home, "AppData", "Roaming"),
    LOCALAPPDATA: join(home, "AppData", "Local"),
    PI_CODING_AGENT_DIR: join(home, ".pi", "agent"),
    PI_OFFLINE: "1",
  };
  for (const key of INHERITED_KEYS) if (process.env[key] !== undefined) environment[key] = process.env[key];
  return { ...environment, ...overrides };
}
