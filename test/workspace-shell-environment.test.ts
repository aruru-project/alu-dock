import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { PiWorkerProcess } from "../src/pi/worker-process.js";
import {
  captureWorkspaceShellEnvironment,
  workspaceShellBootstrapEnvironment,
  type WorkspaceShellAccount,
} from "../src/pi/workspace-shell-environment.js";

test("workspace shell bootstrap admits user session defaults but excludes Host and install-time development state", () => {
  const account: WorkspaceShellAccount = {
    username: "dock-user",
    homedir: "/home/dock-user",
    shell: "/bin/example-shell",
  };
  const environment = workspaceShellBootstrapEnvironment(account, {
    PATH: "/workspace/node_modules/.bin:/rvm/ruby/bin:/usr/bin",
    NODE_ENV: "production",
    ALU_DOCK_MANAGED: "1",
    ALU_DOCK_SOCKET: "/run/host.sock",
    STATE_DIRECTORY: "/var/lib/private/alu-dock",
    npm_lifecycle_event: "install:local",
    GEM_HOME: "/rvm/gems/project",
    NVM_DIR: "/home/dock-user/.nvm",
    LANG: "en_US.UTF-8",
    LC_TIME: "C",
    TERM: "xterm-256color",
    SSH_AUTH_SOCK: "/run/user/1000/agent.sock",
    ALL_PROXY: "socks5://127.0.0.1:1080",
    HTTPS_PROXY: "http://127.0.0.1:7890",
    XDG_RUNTIME_DIR: "/run/user/1000",
  });

  assert.equal(environment.NODE_ENV, undefined);
  assert.equal(environment.GEM_HOME, undefined);
  assert.equal(environment.NVM_DIR, undefined);
  assert.equal(environment.ALU_DOCK_MANAGED, undefined);
  assert.deepEqual(environment, {
    HOME: "/home/dock-user",
    USER: "dock-user",
    LOGNAME: "dock-user",
    SHELL: "/bin/example-shell",
    PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    TERM: "xterm-256color",
    LANG: "en_US.UTF-8",
    ALL_PROXY: "socks5://127.0.0.1:1080",
    HTTPS_PROXY: "http://127.0.0.1:7890",
    SSH_AUTH_SOCK: "/run/user/1000/agent.sock",
    XDG_RUNTIME_DIR: "/run/user/1000",
    LC_TIME: "C",
  });
});

test("workspace shell capture initializes the shell before cd and returns the workspace export without Host NODE_ENV", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "alu-dock-shell-environment-"));
  const home = join(root, "home");
  const workspace = join(root, "project's workspace");
  const shell = join(root, "fixture-shell");
  await Promise.all([mkdir(home), mkdir(workspace)]);
  await writeFile(join(workspace, ".ruby-version"), "3.3.6\n", "utf8");
  await writeFile(shell, `#!/usr/bin/bash
set -eu
export SHELL_INITIALIZED=yes
export HOST_NODE_ENV_AT_SHELL_START="\${NODE_ENV-unset}"
export HOST_DOCK_STATE_AT_SHELL_START="\${ALU_DOCK_MANAGED-unset}"
cd() {
  builtin cd "$@"
  if [[ -f .ruby-version ]]; then
    export RUBY_VERSION="$(<.ruby-version)"
    export GEM_HOME="$HOME/.rvm/gems/ruby-$RUBY_VERSION"
  fi
}
eval "\${!#}"
`, { encoding: "utf8", mode: 0o700 });
  context.after(() => rm(root, { recursive: true, force: true }));

  const environment = await captureWorkspaceShellEnvironment(workspace, {
    account: { username: "fixture", homedir: home, shell },
    sourceEnvironment: {
      PATH: "/polluted/node_modules/.bin:/usr/bin",
      NODE_ENV: "production",
      ALU_DOCK_MANAGED: "1",
      LANG: "C.UTF-8",
      SSH_AUTH_SOCK: "/run/user/fixture/agent.sock",
    },
    timeoutMs: 2_000,
  });

  assert.equal(environment.SHELL_INITIALIZED, "yes");
  assert.equal(environment.HOST_NODE_ENV_AT_SHELL_START, "unset");
  assert.equal(environment.HOST_DOCK_STATE_AT_SHELL_START, "unset");
  assert.equal(environment.NODE_ENV, undefined);
  assert.equal(environment.RUBY_VERSION, "3.3.6");
  assert.equal(environment.GEM_HOME, `${home}/.rvm/gems/ruby-3.3.6`);
  assert.equal(environment.SSH_AUTH_SOCK, "/run/user/fixture/agent.sock");
  assert.equal(environment.PWD, workspace);
  assert.equal(environment.OLDPWD, undefined);
  assert.doesNotMatch(environment.PATH ?? "", /node_modules/u);
});

test("Pi Worker receives only its captured environment plus explicit Dock bootstrap variables", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "alu-dock-worker-environment-"));
  const cwd = join(root, "workspace");
  const agentDir = join(root, "agent");
  await Promise.all([mkdir(cwd), mkdir(agentDir)]);
  context.after(() => rm(root, { recursive: true, force: true }));

  const previousNodeEnv = process.env.NODE_ENV;
  const previousHostOnly = process.env.ALU_DOCK_HOST_ONLY;
  process.env.NODE_ENV = "production";
  process.env.ALU_DOCK_HOST_ONLY = "must-not-leak";
  const worker = new PiWorkerProcess({
    identity: {
      hostEpoch: "environment-host",
      instanceId: "environment-instance",
      runtimeGeneration: 1,
      workerIncarnation: "environment-incarnation",
    },
    init: { cwd, agentDir, projectTrusted: true, tools: [] },
    environment: {
      HOME: root,
      PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      WORKSPACE_VALUE: "captured",
    },
    entry: fileURLToPath(new URL("./fixtures/worker-environment-probe.js", import.meta.url)),
  });
  try {
    await new Promise<void>((resolveExit, rejectExit) => {
      worker.child.once("error", rejectExit);
      worker.child.once("exit", (code, signal) => {
        if (code === 0) resolveExit();
        else rejectExit(new Error(`Worker environment probe failed: ${signal ?? code}`));
      });
    });
    const observed = JSON.parse(await readFile(join(agentDir, "worker-environment.json"), "utf8")) as Record<string, unknown>;
    assert.deepEqual(observed, {
      cwd,
      nodeEnv: null,
      hostOnly: null,
      workspaceValue: "captured",
      workerMarker: "1",
      hasIdentity: true,
      hasInit: true,
    });
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previousNodeEnv;
    if (previousHostOnly === undefined) delete process.env.ALU_DOCK_HOST_ONLY; else process.env.ALU_DOCK_HOST_ONLY = previousHostOnly;
    await worker.terminate().catch(() => {});
  }
});
