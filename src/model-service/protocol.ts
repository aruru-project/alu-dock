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
