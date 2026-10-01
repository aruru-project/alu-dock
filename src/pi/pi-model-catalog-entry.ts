// One-shot process started by the Host to list the models a new Work on this
// computer could select. It loads Pi like a Worker does (login-shell
// environment, global extensions) so extension code never runs inside the Host.
import { listAvailablePiModels } from "./pi-environment.js";
import { enterPiWorkerRuntime } from "./pi-runtime-environment.js";

type CatalogMessage = { ok: true; body: unknown } | { ok: false; message: string };

async function main(): Promise<void> {
  const agentDir = process.env.PI_CODING_AGENT_DIR;
  let message: CatalogMessage;
  try {
    message = { ok: true, body: await listAvailablePiModels(agentDir ? { agentDir } : {}) };
  } catch (error) {
    message = { ok: false, message: (error instanceof Error ? error.message : String(error)).slice(0, 2_000) };
  }
  // Stay alive after answering: the Host ends this process together with anything an
  // extension started, which on Windows needs the parent still running to find them.
  process.send?.(message);
}

if (typeof process.send === "function") {
  // Like a Worker: extensions that start Pi through process.argv[1] must reach Pi's CLI, not this entry.
  enterPiWorkerRuntime();
  // The Host stopped waiting (it stopped or gave up); there is no one left to answer.
  process.on("disconnect", () => process.exit(0));
  void main();
}
