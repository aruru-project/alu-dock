import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";

/** Keep PTY clients away from the real user's Dock state and attachment store. */
export async function ptyUserEnvironment(
  root: string,
  overrides: NodeJS.ProcessEnv = {},
): Promise<NodeJS.ProcessEnv> {
  const isolatedRoot = resolve(root);
  const home = join(isolatedRoot, "home");
  const state = join(isolatedRoot, "state");
  const data = join(isolatedRoot, "data");
  await Promise.all([
    mkdir(home, { recursive: true, mode: 0o700 }),
    mkdir(state, { recursive: true, mode: 0o700 }),
    mkdir(data, { recursive: true, mode: 0o700 }),
  ]);
  return {
    ...process.env,
    ...overrides,
    HOME: home,
    XDG_STATE_HOME: state,
    XDG_DATA_HOME: data,
    // systemd's state path takes precedence over XDG_STATE_HOME.
    STATE_DIRECTORY: "",
  };
}
