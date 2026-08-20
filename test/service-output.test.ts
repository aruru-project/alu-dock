import assert from "node:assert/strict";
import test from "node:test";

import type { UserServiceStatus } from "../src/deployment/user-service.js";
import { renderHumanServiceStatus } from "../src/service-output.js";

test("service status reports the user result and next step without systemd internals", () => {
  const ready = status({ installed: true, ready: true, activeState: "active", mainPid: 8421, hostEpoch: "private-epoch" });
  assert.equal(renderHumanServiceStatus("status", ready), "Alu Dock is ready.\n");

  const starting = status({ installed: true, activeState: "active" });
  assert.equal(
    renderHumanServiceStatus("status", starting),
    "Alu Dock is running, but it is not ready yet.\nNext: aludock service logs --lines 200\n",
  );

  const absent = status({ installed: false });
  assert.equal(
    renderHumanServiceStatus("status", absent),
    "Alu Dock is not installed for this user.\nInstall it: aludock service install --now\n",
  );

  for (const internal of ["8421", "private-epoch", "activeState", "subState", "unitFileState"]) {
    assert.doesNotMatch(renderHumanServiceStatus("status", ready), new RegExp(internal, "u"));
  }
});

function status(overrides: Partial<UserServiceStatus>): UserServiceStatus {
  return {
    unit: "alu-dock.service",
    unitFile: "/home/user/.config/systemd/user/alu-dock.service",
    activeState: "inactive",
    subState: "dead",
    unitFileState: "disabled",
    installed: true,
    mainPid: 0,
    ready: false,
    linger: "yes",
    diagnostics: [],
    ...overrides,
  };
}
