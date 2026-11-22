import { CatalogEffectUnknownError, CatalogWriteError, MutationFaultedError } from "../core/catalog.js";
import {
  InstanceAdmissionPendingError,
  InstanceBusyError,
  InstanceNotActiveError,
  RuntimeEffectUnknownError,
} from "../core/managed-instance.js";
import { AgentCompactionKnownFailureError, AgentInvalidTreeTargetError, AgentUnavailableBeforeEffectError } from "../core/agent-worker.js";
import type { DockRegistry } from "./dock-registry.js";
import type { OperationLedger } from "./operation-ledger.js";
import { ResourceContentError } from "../core/resource-content.js";
import { ProtocolValidationError, type ControlRequest } from "./protocol.js";

type SessionCommandRequest = Extract<ControlRequest, {
  type: "session.switch" | "session.new" | "session.name" | "session.compact" | "session.reload" | "system.set" | "session.navigate" | "session.fork" | "session.clone";
}>;

export function isSessionCommandRequest(request: ControlRequest): request is SessionCommandRequest {
  return request.type === "session.switch"
    || request.type === "session.new"
    || request.type === "session.name"
    || request.type === "session.compact"
    || request.type === "system.set"
    || request.type === "session.reload"
    || request.type === "session.navigate"
    || request.type === "session.fork"
    || request.type === "session.clone";
}

export async function executeSessionCommand(
  request: SessionCommandRequest,
  registry: DockRegistry,
  operationLedger: OperationLedger,
): Promise<unknown> {
  switch (request.type) {
    case "session.switch": return operationLedger.run(request.params.operationId, request.type, request.params, async () => {
      const instance = registry.get(request.params.instanceId);
      const releaseClaim = registry.claimSessionFile(instance.id, request.params.operationId, request.params.sessionFile);
      try {
        const target = await instance.resolveSessionTarget(request.params.sessionFile);
        const trust = await registry.resolveProjectTrust({
          operationType: "session.switch",
          operationId: request.params.operationId,
          cwd: target.canonicalCwd,
          name: request.params.sessionFile,
          trustChallengeId: request.params.trustChallengeId,
          projectTrustDecision: request.params.projectTrustDecision,
        });
        const replacement = await runtimeMutation(request.params.operationId, () => instance.switchSession(
          request.params.operationId,
          request.params.sessionFile,
          trust,
        ));
        return { cancelled: replacement.cancelled, instance: instance.snapshot() };
      } finally {
        releaseClaim();
      }
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
    case "system.set":
    case "session.reload": return operationLedger.run(request.params.operationId, request.type, request.params, async () => {
      const instance = registry.get(request.params.instanceId);
      if (request.type === "system.set" && instance.assistant) throw new ProtocolValidationError("invalid_request", "常驻助手不使用 Pi 的基础 system。请从助手设置修改人设。");
      const { projection } = await runtimeMutation(request.params.operationId, () => instance.reloadSession(request.params.operationId,
        request.type !== "system.set" ? undefined : async (current) => {
          if (!registry.systemService) throw new ProtocolValidationError("capability_missing", "这台机器的 Dock 还不支持切换当前 Work 的 system。请更新这台机器的 Dock。");
          const selected = await registry.systemService.resolveSelection(instance.cwd, request.params.id, current);
          if (selected.kind === "project-system" && instance.projectTrust()?.projectTrusted === false) throw new ResourceContentError("这个 Work 未信任当前项目。请选择全局 SYSTEM.md、Dock 模板或不指定。");
          return selected.workerConfig;
        }), request.type === "system.set");
      return { instance: instance.snapshot(), ...projection };
    });
    case "session.navigate": return operationLedger.run(request.params.operationId, request.type, request.params, async () => {
      const instance = registry.get(request.params.instanceId);
      const result = await runtimeMutation(request.params.operationId, () => instance.navigateSession(
        request.params.operationId,
        request.params.targetId,
        {
          ...(request.params.summarize === undefined ? {} : { summarize: request.params.summarize }),
          ...(request.params.customInstructions === undefined ? {} : { customInstructions: request.params.customInstructions }),
          ...(request.params.replaceInstructions === undefined ? {} : { replaceInstructions: request.params.replaceInstructions }),
          ...(request.params.label === undefined ? {} : { label: request.params.label }),
        },
      ));
      return {
        cancelled: result.cancelled,
        ...(result.aborted === undefined ? {} : { aborted: result.aborted }),
        ...(result.editorText === undefined ? {} : { editorText: result.editorText }),
        instance: instance.snapshot(),
      };
    });
    case "session.fork": return operationLedger.run(request.params.operationId, request.type, request.params, async () => {
      const instance = registry.get(request.params.instanceId);
      const result = await runtimeMutation(request.params.operationId, () => instance.forkSession(
        request.params.operationId,
        request.params.entryId,
      ));
      return {
        cancelled: result.cancelled,
        ...(result.selectedText === undefined ? {} : { selectedText: result.selectedText }),
        instance: instance.snapshot(),
      };
    });
    case "session.clone": return operationLedger.run(request.params.operationId, request.type, request.params, async () => {
      const instance = registry.get(request.params.instanceId);
      const result = await runtimeMutation(request.params.operationId, () => instance.cloneSession(request.params.operationId, request.params.entryId));
      return { cancelled: result.cancelled, instance: instance.snapshot() };
    });
  }
}

async function runtimeMutation<T>(operationId: string, mutate: () => Promise<T>, systemSet = false): Promise<T> {
  try { return await mutate(); }
  catch (error) {
    if (
      (systemSet && (error instanceof ResourceContentError || error instanceof ProtocolValidationError))
      || error instanceof CatalogEffectUnknownError
      || error instanceof CatalogWriteError
      || error instanceof MutationFaultedError
      || error instanceof RuntimeEffectUnknownError
      || error instanceof AgentCompactionKnownFailureError
      || error instanceof AgentUnavailableBeforeEffectError
      || error instanceof InstanceNotActiveError
      || error instanceof InstanceBusyError
      || error instanceof InstanceAdmissionPendingError
      || error instanceof AgentInvalidTreeTargetError
    ) throw error;
    throw new RuntimeEffectUnknownError(operationId, error);
  }
}
