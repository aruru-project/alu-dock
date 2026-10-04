import type { ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";

import { AgentModelNotFoundError } from "../core/agent-worker.js";

/**
 * `workerConfig.model` names the model a new Work starts with, like `pi --model`: it is an
 * exact `{provider, id}` from the machine's model list, applies to every fresh session this
 * Worker creates, and is not saved as Pi's default. A session that has already recorded its
 * own choice (a model change or an answer) keeps it, so reopening after switching models in
 * the Work does not undo the switch.
 */
export async function resolvePiStartingModel(
  input: unknown,
  modelRuntime: Pick<ModelRuntime, "getModel" | "checkAuth">,
  sessionManager: Pick<SessionManager, "getBranch">,
): Promise<ReturnType<ModelRuntime["getModel"]>> {
  if (input === undefined) return undefined;
  if (input === null || typeof input !== "object" || Array.isArray(input)) throw unreadable();
  const { provider, id } = input as { provider?: unknown; id?: unknown };
  if (typeof provider !== "string" || typeof id !== "string" || provider.length === 0 || id.length === 0) throw unreadable();
  if (sessionHasRecordedModel(sessionManager)) return undefined;
  const model = modelRuntime.getModel(provider, id);
  // The same failure as `model.set`, so clients explain it the same way.
  if (!model || !(await modelRuntime.checkAuth(provider))) throw new AgentModelNotFoundError(provider, id);
  return model;
}

function sessionHasRecordedModel(sessionManager: Pick<SessionManager, "getBranch">): boolean {
  return sessionManager.getBranch().some((entry) =>
    entry.type === "model_change" || (entry.type === "message" && entry.message.role === "assistant"));
}

function unreadable(): Error {
  return new Error("新建时选择的模型信息无法识别。请重新新建 Work 并重新选择模型。");
}
