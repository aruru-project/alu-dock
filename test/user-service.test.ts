import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ControlClientError } from "../src/control/dock-client.js";
import {
  UserServiceManager,
  type ServiceCommandRunner,
} from "../src/deployment/user-service.js";

function fakeManager(home: string): {
  manager: UserServiceManager;
  calls: string[];
  state: { active: boolean; pid: number; epoch: string };
} {
  const calls: string[] = [];
  const state = { active: false, pid: 41, epoch: "epoch-one" };
  const run: ServiceCommandRunner = (executable, args) => {
    calls.push(`${executable} ${args.join(" ")}`);
    if (executable === "systemctl") {
      const action = args[1];
      if (action === "start") state.active = true;
      if (action === "restart") { state.active = true; state.pid += 1; state.epoch = "epoch-two"; }
      if (action === "stop" || action === "disable") state.active = false;
      if (action === "show") {
        return {
          status: 0,
          stdout: `ActiveState=${state.active ? "active" : "inactive"}\nSubState=${state.active ? "running" : "dead"}\nMainPID=${state.active ? state.pid : 0}\nUnitFileState=enabled\n`,
          stderr: "",
        };
      }
    }
    if (executable === "loginctl") return { status: 0, stdout: "yes\n", stderr: "" };
    if (executable === "journalctl") return { status: 0, stdout: "journal fixture\n", stderr: "" };
    return { status: 0, stdout: "", stderr: "" };
  };
  const manager = new UserServiceManager({
    home,
    nodePath: "/opt/node/bin/node",
    cliPath: "/srv/alu-dock/dist/src/cli.js",
    socketPath: join(home, "dock.sock"),
    timeoutMs: 50,
    run,
    probe: async () => {
      if (!state.active) throw new ControlClientError("connection_error", "inactive");
      return { pid: state.pid, protocolVersion: 2, hostEpoch: state.epoch, capabilities: ["catalog.v1", "core.v2", "service.managed.v1", "session.reopen", "session.tree.v1"] };
    },
    sleep: async () => {},
  });
  return { manager, calls, state };
}

test("explicit service lifecycle installs a generated unit and preserves catalog on uninstall", async () => {
  const home = await mkdtemp(join(tmpdir(), "alu-dock-service-"));
  const { manager, calls, state } = fakeManager(home);
  const installed = await manager.install(true);
  assert.equal(installed.ready, true);
  assert.equal(installed.mainPid, 41);
  assert.equal(installed.hostEpoch, "epoch-one");
  const unit = await readFile(manager.unitFile, "utf8");
  assert.match(unit, /serve --managed/);
  assert.match(unit, /RuntimeDirectory=alu-dock/);
  assert.match(unit, /StateDirectory=alu-dock/);
  assert.match(unit, /KillMode=mixed/);
  assert.match(unit, /WorkingDirectory=%h/);

  const restarted = await manager.restart();
  assert.equal(restarted.ready, true);
  assert.equal(restarted.mainPid, 42);
  assert.equal(restarted.hostEpoch, "epoch-two");
  assert.equal(state.active, true);

  const logs = manager.logs(50, true);
  assert.equal(logs.status, 0);
  assert.ok(calls.some((call) => call.includes("journalctl --user -u alu-dock.service -n 50 --no-pager --follow")));

  const catalog = join(home, ".local", "state", "alu-dock", "catalog.json");
  await mkdir(join(home, ".local", "state", "alu-dock"), { recursive: true });
  await writeFile(catalog, "catalog evidence\n");
  const stopped = await manager.stop();
  assert.equal(stopped.ready, false);
  const removed = await manager.uninstall();
  assert.equal(removed.removed, true);
  await assert.rejects(access(manager.unitFile));
  assert.equal(await readFile(catalog, "utf8"), "catalog evidence\n");
  assert.ok(calls.some((call) => call === "systemctl --user daemon-reload"));
  assert.ok(calls.some((call) => call === "systemctl --user enable alu-dock.service"));
});

test("service install refuses to overwrite a non-generated user unit", async () => {
  const home = await mkdtemp(join(tmpdir(), "alu-dock-service-owned-"));
  const { manager, calls } = fakeManager(home);
  await mkdir(join(home, ".config", "systemd", "user"), { recursive: true });
  await writeFile(manager.unitFile, "[Service]\nExecStart=/bin/false\n");
  await assert.rejects(manager.install(false), /non-generated/);
  await assert.rejects(manager.uninstall(), /non-generated/);
  assert.equal(calls.some((call) => call.includes("disable --now")), false);
  assert.equal(await readFile(manager.unitFile, "utf8"), "[Service]\nExecStart=/bin/false\n");
});

test("service readiness requires MainPID match and complete managed capabilities", async () => {
  const home = await mkdtemp(join(tmpdir(), "alu-dock-service-pid-"));
  const run: ServiceCommandRunner = (executable, args) => {
    if (executable === "systemctl" && args[1] === "show") {
      return { status: 0, stdout: "ActiveState=active\nSubState=running\nMainPID=99\nUnitFileState=enabled\n", stderr: "" };
    }
    if (executable === "journalctl") return { status: 0, stdout: "pid mismatch journal", stderr: "" };
    if (executable === "loginctl") return { status: 0, stdout: "no\n", stderr: "" };
    return { status: 0, stdout: "", stderr: "" };
  };
  let probePid = 98;
  const manager = new UserServiceManager({
    home,
    nodePath: "/opt/node/bin/node",
    cliPath: "/srv/alu-dock/dist/src/cli.js",
    socketPath: join(home, "dock.sock"),
    timeoutMs: 2,
    run,
    probe: async () => ({ pid: probePid, protocolVersion: 2, hostEpoch: "same", capabilities: [] }),
    sleep: async () => {},
  });
  await manager.install(false);
  await assert.rejects(manager.start(), /hello PID 98 does not match unit MainPID 99/);
  probePid = 99;
  await assert.rejects(manager.start(), /complete managed catalog\/reopen capability set/);
  const status = await manager.status();
  assert.equal(status.ready, false);
  assert.equal(status.linger, "no");
  assert.ok(status.diagnostics.some((item) => item.includes("linger")));
});
