import { resolve } from "node:path";

import { createPiAgentAdapter, type PiAgentAdapter } from "./pi-agent-adapter.js";
import { openValidatedPiSession } from "./pi-session-target.js";
import { WorkerExtensionUiEndpoint, WorkerUiLifecycleCancelledError } from "./worker-extension-ui.js";
import type { UiCapability } from "../worker/worker-protocol.js";
import { runAgentWorker, type WorkerAgent, type WorkerHost } from "../worker/worker-shell.js";
import type { PiWorkerInitOptions } from "./pi-worker-launch.js";
import type { AgentWorkerState } from "../core/agent-worker.js";
import { cloneWorkerConfig } from "../core/worker-config.js";
import { parseAllowedTools } from "../core/worker-tool-policy.js";
import { DockToolsBridge } from "./dock-tools-extension.js";
import { enterPiWorkerRuntime } from "./pi-runtime-environment.js";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { mainModelOwner } from "../model-service/owner.js";

if (process.env.ALU_DOCK_PI_WORKER === "1" && typeof process.send === "function") {
  enterPiWorkerRuntime();
  void runAgentWorker({ parseInit, create: createPiWorkerAgent, replacedCallError: () => new WorkerUiLifecycleCancelledError() }).catch((error) => {
    try { process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`); } catch {}
    process.exit(1);
  });
}

/** Pi inside the Worker shell: its adapter, the extension UI endpoint and the Dock tools bridge. */
async function createPiWorkerAgent(init: PiWorkerInitOptions, host: WorkerHost): Promise<WorkerAgent> {
  const ui = new WorkerExtensionUiEndpoint(host.call);
  // With Main's model service the Work takes its model configuration and credentials from Main and
  // reads none of this machine's; it still sends and handles its own requests. There is no local fallback.
  // Each session gets its own runtime, so providers one session's extensions registered do not outlive it.
  const modelOwner = host.models ? mainModelOwner(host.models) : undefined;
  const createModelRuntime = modelOwner ? () => ModelRuntime.create({ owner: modelOwner }) : undefined;
  const dockToolsBridge: DockToolsBridge = new DockToolsBridge(host.dockToolsEnabled(), {
    configure: async (action) => ({ enabled: action === "status" ? dockToolsBridge.enabled : await host.configureDockTools(action === "on") }),
    invoke: host.invokeDockTool,
  }, init.child === true);

  const sessionPath = init.sessionFile ? resolve(init.sessionFile) : undefined;
  const reopened = sessionPath
    ? await openValidatedPiSession(sessionPath, init.sessionDir ? resolve(init.sessionDir) : undefined, init.cwd)
    : undefined;
  if (reopened && reopened.cwd !== init.cwd) throw new Error("Pi session working directory changed before worker runtime construction");
  const runtime = await createPiAgentAdapter({
    cwd: init.cwd,
    agentDir: init.agentDir,
    ...(init.sessionDir === undefined ? {} : { sessionDir: init.sessionDir }),
    ...(init.tools === undefined ? {} : { tools: init.tools }),
    ...(init.excludeTools === undefined ? {} : { excludeTools: init.excludeTools }),
    ...(init.workerConfig === undefined ? {} : { workerConfig: init.workerConfig }),
    ...(init.child === undefined ? {} : { child: init.child }),
    ...(init.allowedTools === undefined ? {} : { allowedTools: init.allowedTools }),
    projectTrusted: init.projectTrusted,
    extensionUiBroker: ui,
    extensionUiContextPortFactory: () => ui.createGenerationPort(),
    setProcessCwd: (cwd) => process.chdir(cwd),
    ...(reopened === undefined ? {} : { sessionManager: reopened.manager }),
    dockToolsBridge,
    ...(host.attachments === undefined ? {} : { dockAttachmentPort: { access: host.attachments } }),
    ...(createModelRuntime === undefined ? {} : { createModelRuntime }),
  });
  if (init.initialName !== undefined && (!reopened || init.child)) runtime.currentSession().setSessionName(init.initialName);
  return {
    dispatch: (request, context, preflight) => {
      const dispatch = (): Promise<unknown> => runtime.dispatch(request, context, preflight);
      return request.type === "command.submit" && runtime.classifyInput(request.params.message) === "extension_command"
        ? ui.withCommandNotificationOrigin(request.params.operationId, dispatch)
        : dispatch();
    },
    control: async (control) => {
      if (control.type === "observation_delivery") { dockToolsBridge.deliver(control.notification); return null; }
      if (control.type === "work_message") { dockToolsBridge.receive(control.message); return null; }
      return runtime.control(control);
    },
    hostCall: (capability, args) => dispatchHostUi(ui, capability, args),
    subscribe: (listener) => runtime.subscribe(listener),
    state: () => captureState(runtime),
    dispose: () => runtime.dispose(),
    diagnostics: runtime.diagnostics,
    ...(runtime.modelFallbackMessage === undefined ? {} : { modelFallbackMessage: runtime.modelFallbackMessage }),
    get persistedName() { return runtime.currentSession().sessionManager.getSessionName(); },
  };
}

function dispatchHostUi(ui: WorkerExtensionUiEndpoint, capability: UiCapability, args: Record<string, unknown>): unknown {
  switch (capability) {
    case "ui.setToolsExpanded": ui.applyHostToolsExpanded(args.expanded === true); return null;
    case "ui.viewport": ui.setViewport(args.width as number, args.height as number); return null;
    case "ui.reset": ui.resetFromHost(); return null;
    default: throw new Error(`Host cannot invoke child UI capability ${capability}`);
  }
}

function captureState(runtime: PiAgentAdapter): AgentWorkerState {
  return {
    sessionId: runtime.sessionId,
    ...(runtime.sessionFile === undefined ? {} : { sessionFile: runtime.sessionFile }),
    ...(runtime.getDurableSessionFile() === undefined ? {} : { durableSessionFile: runtime.getDurableSessionFile() }),
    isStreaming: runtime.isStreaming,
    ...(runtime.isPreparing ? { isPreparing: true } : {}),
    isCompacting: runtime.isCompacting,
    ...(runtime.getGitBranch() === undefined ? {} : { gitBranch: runtime.getGitBranch() }),
    modelState: runtime.getModelState(),
    metrics: runtime.getMetrics(),
    extensionCommands: runtime.getExtensionCommandNames(),
  };
}

function parseInit(raw: unknown): PiWorkerInitOptions {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Worker init is invalid");
  const value = raw as Record<string, unknown>;
  const allowed = new Set(["cwd", "agentDir", "sessionDir", "tools", "excludeTools", "workerConfig", "child", "allowedTools", "projectTrusted", "sessionFile", "initialName"]);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`Worker init contains unknown field ${key}`);
  const text = (input: unknown, limit: number, label: string, optional = false): string | undefined => {
    if (input === undefined && optional) return undefined;
    if (typeof input !== "string" || input.length < 1 || input.length > limit) throw new Error(`${label} is invalid`);
    return input;
  };
  const list = (input: unknown, label: string): string[] | undefined => {
    if (input === undefined) return undefined;
    if (!Array.isArray(input) || input.length > 2_000) throw new Error(`${label} is invalid`);
    return input.map((item) => text(item, 256, label) as string);
  };
  if (typeof value.projectTrusted !== "boolean") throw new Error("Worker init project trust is invalid");
  if (value.child !== undefined && value.child !== true) throw new Error("Worker init child role is invalid");
  return {
    cwd: text(value.cwd, 16_384, "Worker cwd") as string,
    agentDir: text(value.agentDir, 16_384, "Worker agent directory") as string,
    ...(text(value.sessionDir, 16_384, "Worker session directory", true) === undefined ? {} : { sessionDir: value.sessionDir as string }),
    ...(list(value.tools, "Worker tools") === undefined ? {} : { tools: list(value.tools, "Worker tools") }),
    ...(list(value.excludeTools, "Worker excluded tools") === undefined ? {} : { excludeTools: list(value.excludeTools, "Worker excluded tools") }),
    ...(value.workerConfig === undefined ? {} : { workerConfig: cloneWorkerConfig(value.workerConfig, "Worker configuration") }),
    ...(value.child === undefined ? {} : { child: true as const }),
    ...(value.allowedTools === undefined ? {} : { allowedTools: parseAllowedTools(value.allowedTools) }),
    projectTrusted: value.projectTrusted,
    ...(text(value.sessionFile, 16_384, "Worker session file", true) === undefined ? {} : { sessionFile: value.sessionFile as string }),
    ...(text(value.initialName, 256, "Worker initial name", true) === undefined ? {} : { initialName: value.initialName as string }),
  };
}
