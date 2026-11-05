import type { AnyModel, AuthResult } from "@earendil-works/pi-ai";
import type { ModelRuntimeOwnerAuthState, ModelRuntimeOwnerConfiguration } from "@earendil-works/pi-coding-agent";

/*
 * What a Work asks Main's model service (card #303). Main keeps the model configuration and the
 * credentials; every Work composes, sends and handles its own requests with them, so replies never
 * pass through Main and each Work handles only its own.
 */

/** Overrides a Work may pass when it asks for a credential; its cancel is relayed separately. */
export interface ModelAuthOverrides {
  apiKey?: string;
  env?: Record<string, string>;
  minOAuthValidityMs?: number;
}

/**
 * One credential, for the Work's own request or for an extension calling a model itself. Main
 * resolves and refreshes it; a subscription yields a short-lived token, never its refresh token.
 */
export interface ModelAuthRequest {
  /** A provider, or the model being called, whose own headers take part. */
  target: string | AnyModel;
  overrides?: ModelAuthOverrides;
}

export type ModelConfiguration = ModelRuntimeOwnerConfiguration;
export type ModelAuthState = ModelRuntimeOwnerAuthState;
export type ModelAuthResult = AuthResult | null;

export type ModelServiceRequest =
  | { op: "configuration" }
  | { op: "auth_state" }
  | ({ op: "auth" } & ModelAuthRequest);

/** The largest answer Main sends a SubHost: its models.json and stored catalogs, with room to grow. */
export const MAX_MODEL_ANSWER_BYTES = 32 * 1024 * 1024;

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

/** Checks a question that arrived from another machine before Main's service sees it. */
export function parseModelServiceRequest(raw: unknown): ModelServiceRequest {
  if (!isRecord(raw)) throw new Error("Model question must be an object");
  const extra = (allowed: string[]) => Object.keys(raw).some((key) => !allowed.includes(key));
  if (raw.op === "configuration" || raw.op === "auth_state") {
    if (extra(["op"])) throw new Error("Model question has unexpected fields");
    return { op: raw.op };
  }
  if (raw.op !== "auth" || extra(["op", "target", "overrides"])) throw new Error("Model question is invalid");
  const { target, overrides } = raw;
  const validTarget = typeof target === "string"
    ? target.length > 0 && target.length <= 256
    : isRecord(target) && typeof target.provider === "string" && typeof target.id === "string";
  if (!validTarget) throw new Error("Model question names no provider or model");
  if (overrides === undefined) return { op: "auth", target: target as ModelAuthRequest["target"] };
  if (!isRecord(overrides) || Object.keys(overrides).some((key) => !["apiKey", "env", "minOAuthValidityMs"].includes(key))) throw new Error("Model question overrides are invalid");
  if (overrides.apiKey !== undefined && typeof overrides.apiKey !== "string") throw new Error("Model question API key is invalid");
  if (overrides.env !== undefined && (!isRecord(overrides.env) || Object.values(overrides.env).some((value) => typeof value !== "string"))) throw new Error("Model question environment is invalid");
  if (overrides.minOAuthValidityMs !== undefined && !(typeof overrides.minOAuthValidityMs === "number" && Number.isFinite(overrides.minOAuthValidityMs) && overrides.minOAuthValidityMs >= 0)) throw new Error("Model question validity is invalid");
  return { op: "auth", target: target as ModelAuthRequest["target"], overrides: overrides as ModelAuthOverrides };
}
