import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { MODEL_SERVICE_STATE_DIR_ENV } from "../../src/model-service/service-messages.js";

// PR review P1 (2026-11-16): the real service is killed; its replacement is alive but not ready.
// Release it from the test so the same pending refresh can finish through the production service.
const root = process.env[MODEL_SERVICE_STATE_DIR_ENV]!;
const started = join(root, "model-service-started");
if (existsSync(started)) {
  writeFileSync(join(root, "model-service-restarting"), String(process.pid));
  process.on("disconnect", () => process.exit(0));
  await new Promise<void>(resolve => {
    const timer = setInterval(() => {
      if (!existsSync(join(root, "model-service-release"))) return;
      clearInterval(timer);
      resolve();
    }, 20);
  });
} else {
  writeFileSync(started, String(process.pid));
}
await import("../../src/model-service/service-entry.js");
