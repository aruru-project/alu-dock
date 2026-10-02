import { join } from "node:path";

const INHERITED_KEYS = ["PATH", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "TMPDIR", "TEMP", "TMP", "SystemRoot", "WINDIR", "ComSpec", "PATHEXT"] as const;

/**
 * Card #351: Hosts and Pi Workers given `...process.env` inside a Dock-managed Pi
 * inherited that Pi's real `PI_CODING_AGENT_DIR`, Worker identity and exported
 * credentials. Child Hosts, TUI clients and Worker `workerEnvironment` start from
 * this short list instead, with every user directory under the test's own home.
 *
 * Passing this to a CLI-started Host does not isolate the Workers it creates:
 * their environment comes from the system account's login shell (see docs/qa.md).
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
