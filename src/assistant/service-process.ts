import { fileURLToPath } from "node:url";

import { ServiceAnswerError, SupervisedService } from "../control/service-supervisor.js";
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

export interface AssistantServiceProcessOptions {
  /** Where her persona, the owner's notes and her memory are kept on Main. */
  directory: string;
  /** Her working directory on Main, for chats and chores outside any project. */
  workspacePath: string;
  /** Test seam; production passes the Host's own environment. */
  environment?: NodeJS.ProcessEnv;
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
        ...(options.environment ?? process.env),
        [ASSISTANT_DIR_ENV]: options.directory,
        [ASSISTANT_WORKSPACE_ENV]: options.workspacePath,
      }),
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
