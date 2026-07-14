import { EventEmitter } from "node:events";

import type { SettingsManager } from "@earendil-works/pi-coding-agent";
import * as undici from "undici";

const DEFAULT_HTTP_IDLE_TIMEOUT_MS = 300_000;
const originalGlobalFetch = globalThis.fetch;
let installedGlobalFetch: typeof globalThis.fetch | undefined;
let installedConfiguration: string | undefined;

/**
 * Apply the same process-wide proxy and Undici bootstrap as Pi 0.80.6 CLI.
 *
 * SDK runtime factories intentionally do not initialize network globals; Pi's
 * CLI does that in main() before creating a runtime. Dock is the SDK process,
 * so it must own the equivalent bootstrap before any managed session starts.
 */
export function configurePiNetwork(settingsManager: SettingsManager): void {
  applyHttpProxySettings(settingsManager.getGlobalSettings().httpProxy);
  const timeoutMs = settingsManager.getHttpIdleTimeoutMs();
  const configuration = JSON.stringify({
    timeoutMs,
    HTTP_PROXY: process.env.HTTP_PROXY,
    HTTPS_PROXY: process.env.HTTPS_PROXY,
    NO_PROXY: process.env.NO_PROXY,
    http_proxy: process.env.http_proxy,
    https_proxy: process.env.https_proxy,
    no_proxy: process.env.no_proxy,
  });
  if (configuration === installedConfiguration) return;
  configureHttpDispatcher(timeoutMs);
  installedConfiguration = configuration;
}

function applyHttpProxySettings(httpProxy: string | undefined): void {
  const proxy = httpProxy?.trim();
  if (!proxy) return;
  process.env.HTTP_PROXY ??= proxy;
  process.env.HTTPS_PROXY ??= proxy;
}

function configureHttpDispatcher(timeoutMs = DEFAULT_HTTP_IDLE_TIMEOUT_MS): void {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
    throw new Error(`Invalid HTTP idle timeout: ${String(timeoutMs)}`);
  }
  const normalizedTimeoutMs = Math.floor(timeoutMs);
  const dispatcher = withUndiciErrorListener(new undici.EnvHttpProxyAgent({
    allowH2: false,
    bodyTimeout: normalizedTimeoutMs,
    headersTimeout: normalizedTimeoutMs,
    clientFactory: createUndiciClient,
    factory: createUndiciOriginDispatcher,
  }));
  undici.setGlobalDispatcher(dispatcher);

  // Keep fetch/WebSocket and the dispatcher on the same Undici implementation,
  // matching Pi's CLI bootstrap. Preserve deliberate third-party replacements.
  const shouldInstallGlobals = installedGlobalFetch === undefined
    ? globalThis.fetch === originalGlobalFetch
    : globalThis.fetch === installedGlobalFetch;
  if (shouldInstallGlobals) {
    undici.install();
    installedGlobalFetch = globalThis.fetch;
  }
}

const ignoreUndiciDispatcherError = (_error: unknown): void => {};

function withUndiciErrorListener<T>(dispatcher: T): T {
  if (dispatcher instanceof EventEmitter) {
    EventEmitter.prototype.on.call(dispatcher, "error", ignoreUndiciDispatcherError);
  }
  return dispatcher;
}

function createUndiciClient(origin: URL, options: object): undici.Client {
  return withUndiciErrorListener(new undici.Client(
    origin,
    options as undici.Client.Options,
  ));
}

function createUndiciOriginDispatcher(origin: URL, options: object): undici.Dispatcher {
  const dispatcherOptions = options as undici.Pool.Options;
  if (dispatcherOptions.connections === 1) {
    return createUndiciClient(origin, dispatcherOptions);
  }
  return withUndiciErrorListener(new undici.Pool(origin, {
    ...dispatcherOptions,
    factory: createUndiciClient,
  }));
}
