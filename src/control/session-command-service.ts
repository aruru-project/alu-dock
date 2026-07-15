import { CatalogEffectUnknownError, CatalogWriteError, MutationFaultedError } from "../core/catalog.js";
import {
  InstanceAdmissionPendingError,
  InstanceBusyError,
  InstanceNotActiveError,
  RuntimeEffectUnknownError,
} from "../core/managed-instance.js";
import type { DockRegistry } from "./dock-registry.js";
import type { OperationLedger } from "./operation-ledger.js";
import type { ControlRequest } from "./protocol.js";

type SessionCommandRequest = Extract<ControlRequest, {
  type: "session.switch" | "session.new" | "session.name" | "session.compact" | "session.reload";
}>;

export function isSessionCommandRequest(request: ControlRequest): request is SessionCommandRequest {
  return request.type === "session.switch"
    || request.type === "session.new"
    || request.type === "session.name"
    || request.type === "session.compact"
    || request.type === "session.reload";
}

export async function executeSessionCommand(
  request: SessionCommandRequest,
  registry: DockRegistry,
  operationLedger: OperationLedger,
): Promise<unknown> {
  switch (request.type) {
    case "session.switch": return operationLedger.run(request.params.operationId, request.type, request.params, async () => {
      const instance = registry.get(request.params.instanceId);
      const target = await instance.resolveSessionTarget(request.params.sessionFile);
      const trust = await registry.resolveProjectTrust({
        operationType: "session.switch",
        operationId: request.params.operationId,
        cwd: target.canonicalCwd,
        trustChallengeId: request.params.trustChallengeId,
        projectTrustDecision: request.params.projectTrustDecision,
      });
      const replacement = await runtimeMutation(request.params.operationId, () => instance.switchSession(
        request.params.operationId,
        request.params.sessionFile,
        trust,
      ));
      return { cancelled: replacement.cancelled, instance: instance.snapshot() };
    });
    case "session.new": return operationLedger.run(request.params.operationId, request.type, request.params, async () => {
      const instance = registry.get(request.params.instanceId);
      const replacement = await runtimeMutation(request.params.operationId, () => instance.newSession(request.params.operationId, request.params.parentSession));
      return { cancelled: replacement.cancelled, instance: instance.snapshot() };
    });
    case "session.name": return operationLedger.run(request.params.operationId, request.type, request.params, async () => {
      const instance = registry.get(request.params.instanceId);
      await runtimeMutation(request.params.operationId, () => instance.setSessionName(request.params.operationId, request.params.name));
      return { instance: instance.snapshot() };
    });
    case "session.compact": return operationLedger.run(request.params.operationId, request.type, request.params, async () => {
      const instance = registry.get(request.params.instanceId);
      const result = await runtimeMutation(request.params.operationId, () => instance.compactSession(request.params.operationId, request.params.customInstructions));
      return { result, instance: instance.snapshot() };
    });
    case "session.reload": return operationLedger.run(request.params.operationId, request.type, request.params, async () => {
      const instance = registry.get(request.params.instanceId);
      const projected = await runtimeMutation(request.params.operationId, async () => {
        await instance.reloadSession(request.params.operationId);
        return instance.getResources();
      });
      return { instance: instance.snapshot(), ...projected };
    });
  }
}

async function runtimeMutation<T>(operationId: string, mutate: () => Promise<T>): Promise<T> {
  try { return await mutate(); }
  catch (error) {
    if (
      error instanceof CatalogEffectUnknownError
      || error instanceof CatalogWriteError
      || error instanceof MutationFaultedError
      || error instanceof RuntimeEffectUnknownError
      || error instanceof InstanceNotActiveError
      || error instanceof InstanceBusyError
      || error instanceof InstanceAdmissionPendingError
    ) throw error;
    throw new RuntimeEffectUnknownError(operationId, error);
  }
}
