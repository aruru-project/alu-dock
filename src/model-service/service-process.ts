import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

import { SupervisedService } from "../control/service-supervisor.js";
import { captureWorkspaceShellEnvironment } from "../platform/workspace-shell-environment.js";
import type { ModelAuthRequest, ModelAuthResult, ModelAuthState, ModelConfiguration, ModelServiceRequest } from "./protocol.js";
import { MODEL_SERVICE_AGENT_DIR_ENV } from "./service-messages.js";

/** What a Host offers its Workers for model access: Main's configuration and credentials. */
export interface ModelHostPort {
  configuration(signal: AbortSignal): Promise<ModelConfiguration>;
  authState(signal: AbortSignal): Promise<ModelAuthState>;
  auth(request: ModelAuthRequest, signal: AbortSignal): Promise<ModelAuthResult>;
}

/**
 * Answers one model question a Work or the assistant service asked: `{ op: "configuration" }`,
 * `{ op: "auth_state" }`, or `{ op: "auth", request }`, as `mainModelOwner` asks them.
 */
export async function answerModelQuestion(port: ModelHostPort, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
  if (args.op === "configuration") return await port.configuration(signal);
  if (args.op === "auth_state") return await port.authState(signal);
  if (args.op === "auth") return await port.auth(args.request as ModelAuthRequest, signal);
  throw new Error("Unknown model question");
}

export class ModelServiceUnavailableError extends Error {
  constructor(message: string) { super(message); this.name = "ModelServiceUnavailableError"; }
}

export interface ModelServiceProcessOptions {
  agentDir: string;
  /** Test seam; production captures the owner's login shell like Workers do, so key variables match. */
  environment?: NodeJS.ProcessEnv;
  entry?: string;
  /** How long a question waits for a starting or restarting service; a Work's start must fit in it. */
  readyWaitMs?: number;
  /** A service that has not said it is ready by then is stopped and started again. */
  startTimeoutMs?: number;
}

const DEFAULT_ENTRY = fileURLToPath(new URL("./service-entry.js", import.meta.url));

/**
 * Starts and watches the model service process for a Host. A crash fails the questions in flight
 * and starts the service again; questions not yet sent wait for it. Replies Works are receiving
 * from providers do not pass through the service and go on.
 */
export class ModelServiceProcess implements ModelHostPort {
  private readonly service: SupervisedService;

  constructor(options: ModelServiceProcessOptions) {
    this.service = new SupervisedService({
      label: "The model service on Main",
      entry: options.entry ?? DEFAULT_ENTRY,
      environment: async () => ({
        ...(options.environment ?? await captureWorkspaceShellEnvironment(homedir())),
        [MODEL_SERVICE_AGENT_DIR_ENV]: options.agentDir,
      }),
      unavailable: (message) => new ModelServiceUnavailableError(message),
      // Main may still finish a login refresh a cancelled question started, so a rotated token is kept.
      cancelledMessage: "Model request cancelled",
      ...(options.readyWaitMs === undefined ? {} : { readyWaitMs: options.readyWaitMs }),
      ...(options.startTimeoutMs === undefined ? {} : { startTimeoutMs: options.startTimeoutMs }),
    });
  }

  /** Resolves when the service first becomes ready; it keeps restarting on its own after that. */
  start(): Promise<void> { return this.service.start(); }
  stop(): Promise<void> { return this.service.stop(); }
  /** The service process while it runs; tests use it to stop the service from outside. */
  get pid(): number | undefined { return this.service.pid; }

  configuration(signal: AbortSignal): Promise<ModelConfiguration> {
    return this.request({ op: "configuration" }, signal) as Promise<ModelConfiguration>;
  }

  authState(signal: AbortSignal): Promise<ModelAuthState> {
    return this.request({ op: "auth_state" }, signal) as Promise<ModelAuthState>;
  }

  auth(request: ModelAuthRequest, signal: AbortSignal): Promise<ModelAuthResult> {
    return this.request({ op: "auth", ...request }, signal) as Promise<ModelAuthResult>;
  }

  private request(request: ModelServiceRequest, signal: AbortSignal): Promise<unknown> {
    return this.service.request(request, signal);
  }
}
