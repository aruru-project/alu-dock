import assert from "node:assert/strict";
import test from "node:test";
import { resolve } from "node:path";

import { defaultCatalogPath } from "../src/control/durable-catalog-store.js";
import { normalizeLocalEndpoint } from "../src/control/local-endpoint.js";
import { defaultSocketPath } from "../src/control/socket-path.js";

test("local Dock startup keeps Unix paths and uses Windows native defaults", () => {
  assert.equal(normalizeLocalEndpoint("./dock.sock", "linux"), resolve("./dock.sock"));
  assert.equal(defaultSocketPath({}, "win32"), "\\\\.\\pipe\\alu-dock");
  assert.equal(normalizeLocalEndpoint("\\\\.\\pipe\\alu-dock-dev", "win32"), "\\\\.\\pipe\\alu-dock-dev");
  assert.equal(
    defaultCatalogPath({ LOCALAPPDATA: "C:\\Users\\owner\\AppData\\Local" }, "C:\\Users\\owner", "win32"),
    "C:\\Users\\owner\\AppData\\Local\\Alu Dock\\catalog.json",
  );
});
