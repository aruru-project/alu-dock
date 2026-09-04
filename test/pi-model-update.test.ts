import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { updatePiModelCatalog } from "../src/pi/pi-environment.js";

test("a user can refresh Pi's saved model list again without replacing Pi", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "alu-dock-model-update-"));
  const originalFetch = globalThis.fetch;
  const requests: string[] = [];
  globalThis.fetch = async (input) => {
    requests.push(String(input));
    return new Response(null, { status: 404 });
  };
  try {
    await updatePiModelCatalog({ agentDir });
    const firstRequestCount = requests.length;
    assert.ok(firstRequestCount > 0);
    const stored = JSON.parse(await readFile(join(agentDir, "models-store.json"), "utf8")) as Record<string, unknown>;
    assert.ok(Object.keys(stored).length > 0);

    await updatePiModelCatalog({ agentDir });
    assert.ok(requests.length > firstRequestCount, "an explicit repeat refreshes the upstream catalog again");
  } finally {
    globalThis.fetch = originalFetch;
    await rm(agentDir, { recursive: true, force: true });
  }
});
