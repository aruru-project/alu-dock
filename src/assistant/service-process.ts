import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

import { ServiceAnswerError, SupervisedService } from "../control/service-supervisor.js";
import { answerModelQuestion, type ModelHostPort } from "../model-service/service-process.js";
import { captureWorkspaceShellEnvironment } from "../pi/workspace-shell-environment.js";
import type { ExtractionTiming } from "./extraction.js";
import {
  AssistantError,
  isAssistantErrorCode,
  parseAssistantResult,
  type AssistantHostPort,
  type AssistantRequest,
  type AssistantResultFor,
  type AssistantSource,
} from "../core/assistant.js";

export const ASSISTANT_DIR_ENV = "ALU_DOCK_ASSISTANT_DIR";
export const ASSISTANT_WORKSPACE_ENV = "ALU_DOCK_ASSISTANT_WORKSPACE";
/** The Pi directory whose network settings her model calls use, as the model service's. */
export const ASSISTANT_AGENT_DIR_ENV = "ALU_DOCK_ASSISTANT_AGENT_DIR";
/** Test seam: shorter waits for extraction and dreaming, as JSON (see ExtractionTiming). */
export const ASSISTANT_TIMING_ENV = "ALU_DOCK_ASSISTANT_TIMING";

export interface AssistantServiceProcessOptions {
  /** Where her persona, the owner's notes and her memory are kept on Main. */
  directory: string;
  /** Her working directory on Main, for chats and chores outside any project. */
  workspacePath: string;
  /** Main's Pi directory, as the model service's. */
  agentDir: string;
  /** Main's model service, which gives her memory passes their model configuration and credentials. */
  models?: ModelHostPort;
  /** Test seam; production captures the owner's login shell like the model service, so her model calls see the same proxy settings. */
  environment?: NodeJS.ProcessEnv;
  /** Test seam: shorter waits for extraction and dreaming. */
  timing?: Partial<ExtractionTiming>;
  entry?: string;
  readyWaitMs?: number;
}

const DEFAULT_ENTRY = fileURLToPath(new URL("./service-entry.js", import.meta.url));

/** Main's assistant service, started and watched by the Host like the model service. */
export class AssistantServiceProcess implements AssistantHostPort {
  private readonly service: SupervisedService;

  constructor(options: AssistantServiceProcessOptions) {
    this.service = new SupervisedService({
      label: "The assistant service on Main",
      entry: options.entry ?? DEFAULT_ENTRY,
      environment: async () => ({
        ...(options.environment ?? await captureWorkspaceShellEnvironment(homedir())),
        [ASSISTANT_DIR_ENV]: options.directory,
        [ASSISTANT_WORKSPACE_ENV]: options.workspacePath,
        [ASSISTANT_AGENT_DIR_ENV]: options.agentDir,
        ...(options.timing === undefined ? {} : { [ASSISTANT_TIMING_ENV]: JSON.stringify(options.timing) }),
      }),
      // What the service asks its Host: model configuration and credentials, for her memory passes.
      answer: async (request, signal) => {
        const question = (request as { model?: unknown } | null)?.model;
        if (!options.models || question === null || typeof question !== "object") throw new Error("This Host offers the assistant service no model access");
        return answerModelQuestion(options.models, question as Record<string, unknown>, signal);
      },
      unavailable: (message) => new AssistantError("assistant_unavailable", message),
      cancelledMessage: "Assistant request cancelled",
      ...(options.readyWaitMs === undefined ? {} : { readyWaitMs: options.readyWaitMs }),
    });
  }

  start(): Promise<void> { return this.service.start(); }
  stop(): Promise<void> { return this.service.stop(); }

  async request<R extends AssistantRequest>(request: R, source: AssistantSource, signal?: AbortSignal): Promise<AssistantResultFor<R>> {
    let answer: unknown;
    try {
      answer = await this.service.request({ request, source }, signal);
    } catch (error) {
      if (error instanceof ServiceAnswerError && isAssistantErrorCode(error.code)) throw new AssistantError(error.code, error.message);
      throw error;
    }
    return parseAssistantResult(request, answer);
  }
}
