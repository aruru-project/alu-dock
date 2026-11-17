import assert from "node:assert/strict";
import test from "node:test";

import { ControlClientError } from "../src/control/dock-client.js";
import { humanControlErrorText } from "../src/human-control-error.js";

// PR review P1: a timed-out read is not a disconnected or stopped Work.
test("A query timeout offers retry without telling the user to reopen their Work", () => {
  assert.equal(humanControlErrorText(new ControlClientError("query_timeout", "private worker detail")),
    "This read timed out. The work was not stopped by this read. Try again in a moment.");
  assert.equal(humanControlErrorText(new ControlClientError("request_failed", "private worker detail")),
    "That action could not be completed. Try again; if it keeps happening, check `aludock service logs --lines 200`.");
});
