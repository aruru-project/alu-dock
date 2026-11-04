import type { ModelServiceRequest, WireModelEvent } from "./protocol.js";

/** Private IPC between a Host and the model service process it supervises. */
export const MODEL_SERVICE_AGENT_DIR_ENV = "ALU_DOCK_MODEL_SERVICE_AGENT_DIR";

export type ServiceInbound =
  | { type: "request"; id: string; request: ModelServiceRequest }
  | { type: "cancel"; id: string };

export type ServiceOutbound =
  | { type: "ready" }
  | { type: "event"; id: string; wire: WireModelEvent }
  | { type: "result"; id: string; ok: true; result: unknown }
  | { type: "result"; id: string; ok: false; error: string };
