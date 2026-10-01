// One-shot process started by the Host to list the models a new Work on this
// computer could select. It loads Pi like a Worker does (login-shell
// environment, global extensions) so extension code never runs inside the Host.
import { listAvailablePiModels } from "./pi-environment.js";

type CatalogMessage = { ok: true; body: unknown } | { ok: false; message: string };

async function main(): Promise<void> {
  const agentDir = process.env.PI_CODING_AGENT_DIR;
  let message: CatalogMessage;
  try {
    message = { ok: true, body: await listAvailablePiModels(agentDir ? { agentDir } : {}) };
  } catch (error) {
    message = { ok: false, message: (error instanceof Error ? error.message : String(error)).slice(0, 2_000) };
  }
  await new Promise<void>((resolveSent) => {
    if (!process.send) { resolveSent(); return; }
    process.send(message, undefined, {}, () => resolveSent());
  });
  // Extensions may leave timers or handles open; the answer is already delivered.
  process.exit(0);
}

void main();
