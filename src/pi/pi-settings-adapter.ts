import type { AgentSession, SettingsManager } from "@earendil-works/pi-coding-agent";

import {
  SETTING_DEFINITIONS,
  SETTING_KEYS,
  type SettingDto,
  type SettingKey,
  type SettingUpdate,
  type SettingValueMap,
} from "../core/config-projection.js";
import { AgentInvalidSettingValueError } from "../core/agent-worker.js";

export function projectPiSettings(manager: SettingsManager): SettingDto[] {
  return SETTING_KEYS.map((key) => projectPiSetting(manager, key));
}

export function projectPiSetting(manager: SettingsManager, key: SettingKey): SettingDto {
  const definition = SETTING_DEFINITIONS[key];
  const value = validatedPiSettingValue(manager, key);
  return {
    key,
    value,
    source: settingSource(manager, key),
    writable: definition.writable,
    valueType: definition.valueType,
    ...(definition.allowedValues ? { allowedValues: [...definition.allowedValues] } : {}),
    ...(definition.min === undefined ? {} : { min: definition.min }),
    ...(definition.max === undefined ? {} : { max: definition.max }),
    reloadRequired: definition.reloadRequired,
    hostRestartRequired: definition.hostRestartRequired,
  } as SettingDto;
}

export function validatedPiSettingValue<K extends SettingKey>(manager: SettingsManager, key: K): SettingValueMap[K] {
  const value = settingValue(manager, key) as SettingValueMap[K];
  try { assertSettingValue(key, value); }
  catch { throw new AgentInvalidSettingValueError(key); }
  return value;
}

export function assertPiSettingUpdate(update: SettingUpdate): void {
  if (update === null || typeof update !== "object" || Array.isArray(update) || Object.keys(update).length !== 2 || !("key" in update) || !("value" in update)) throw new Error("Setting update must be a closed key/value object");
  const key = (update as { key: unknown }).key;
  if (typeof key !== "string" || !SETTING_KEYS.includes(key as SettingKey)) throw new Error(`Unsupported setting key: ${String(key)}`);
  const definition = SETTING_DEFINITIONS[key as SettingKey];
  if (!definition.writable) throw new Error(`Pi setting ${key} is read-only`);
  assertSettingValue(key as SettingKey, (update as { value: unknown }).value);
}

export function applyPiSetting(session: AgentSession, manager: SettingsManager, update: SettingUpdate): void {
  switch (update.key) {
    case "autoCompaction": manager.setCompactionEnabled(update.value); break;
    case "autoRetry": manager.setRetryEnabled(update.value); break;
    case "enableSkillCommands": manager.setEnableSkillCommands(update.value); break;
    case "hideThinking": manager.setHideThinkingBlock(update.value); break;
    case "showCacheMissNotices": manager.setShowCacheMissNotices(update.value); break;
    case "showHardwareCursor": manager.setShowHardwareCursor(update.value); break;
    case "clearOnShrink": manager.setClearOnShrink(update.value); break;
    case "showTerminalProgress": manager.setShowTerminalProgress(update.value); break;
    case "quietStartup": manager.setQuietStartup(update.value); break;
    case "collapseChangelog": manager.setCollapseChangelog(update.value); break;
    case "enableInstallTelemetry": manager.setEnableInstallTelemetry(update.value); break;
    case "steeringMode": session.setSteeringMode(update.value); break;
    case "followUpMode": session.setFollowUpMode(update.value); break;
    case "transport": manager.setTransport(update.value); break;
    case "doubleEscapeAction": manager.setDoubleEscapeAction(update.value); break;
    case "treeFilterMode": manager.setTreeFilterMode(update.value); break;
    case "defaultProjectTrust": manager.setDefaultProjectTrust(update.value); break;
    // The session setter also re-evaluates active warming; the manager setter alone only persists.
    case "cacheWarming": session.setCacheWarmingMode(update.value); break;
    case "httpIdleTimeoutMs": manager.setHttpIdleTimeoutMs(update.value); break;
    case "editorPaddingX": manager.setEditorPaddingX(update.value); break;
    case "outputPad": manager.setOutputPad(update.value); break;
    case "autocompleteMaxVisible": manager.setAutocompleteMaxVisible(update.value); break;
    case "warnings": manager.setWarnings({ ...update.value }); break;
  }
}

export function projectSettingsErrors(errors: Array<{ scope: "global" | "project"; error: Error }>): Array<{ scope: "global" | "project"; message: string }> {
  return errors.map((failure) => ({ scope: failure.scope, message: boundedErrorMessage(failure.error) }));
}

function settingValue(manager: SettingsManager, key: SettingKey): SettingValueMap[SettingKey] {
  switch (key) {
    case "autoCompaction": return manager.getCompactionEnabled();
    case "compactionReserveTokens": return manager.getCompactionReserveTokens();
    case "compactionKeepRecentTokens": return manager.getCompactionKeepRecentTokens();
    case "autoRetry": return manager.getRetryEnabled();
    case "enableSkillCommands": return manager.getEnableSkillCommands();
    case "hideThinking": return manager.getHideThinkingBlock();
    case "showCacheMissNotices": return manager.getShowCacheMissNotices();
    case "showHardwareCursor": return manager.getShowHardwareCursor();
    case "clearOnShrink": return manager.getClearOnShrink();
    case "showTerminalProgress": return manager.getShowTerminalProgress();
    // Pi 1.2 added "header" (keep only the startup header); Dock's setting stays boolean and reads it as quiet.
    case "quietStartup": return manager.getQuietStartup() !== false;
    case "collapseChangelog": return manager.getCollapseChangelog();
    case "enableInstallTelemetry": return manager.getEnableInstallTelemetry();
    case "steeringMode": return manager.getSteeringMode();
    case "followUpMode": return manager.getFollowUpMode();
    case "transport": return manager.getTransport();
    case "doubleEscapeAction": return manager.getDoubleEscapeAction();
    case "treeFilterMode": return manager.getTreeFilterMode();
    case "defaultProjectTrust": return manager.getDefaultProjectTrust();
    case "cacheWarming": return manager.getCacheWarmingMode();
    case "httpIdleTimeoutMs": return manager.getHttpIdleTimeoutMs();
    case "editorPaddingX": return manager.getEditorPaddingX();
    case "outputPad": return manager.getOutputPad();
    case "autocompleteMaxVisible": return manager.getAutocompleteMaxVisible();
    case "warnings": return manager.getWarnings();
  }
}

function settingSource(manager: SettingsManager, key: SettingKey): "global" | "project" | "effective" {
  const { sourcePath: path, globalOnly } = SETTING_DEFINITIONS[key];
  if (!globalOnly && manager.isProjectTrusted() && hasOwnPath(manager.getProjectSettings(), path)) return "project";
  if (hasOwnPath(manager.getGlobalSettings(), path)) return "global";
  return "effective";
}

function hasOwnPath(settings: unknown, path: readonly string[]): boolean {
  let current: unknown = settings;
  for (const part of path) {
    if (current === null || typeof current !== "object" || Array.isArray(current) || !Object.prototype.hasOwnProperty.call(current, part)) return false;
    current = (current as Record<string, unknown>)[part];
  }
  return true;
}

function assertSettingValue(key: SettingKey, value: unknown): void {
  const definition = SETTING_DEFINITIONS[key];
  if (definition.valueType === "boolean" && typeof value !== "boolean") throw new Error(`${key} must be boolean`);
  if (definition.valueType === "enum" && (typeof value !== "string" || !definition.allowedValues?.includes(value))) throw new Error(`${key} has an unsupported value`);
  if (definition.valueType === "integer" && (!Number.isSafeInteger(value) || (value as number) < (definition.min ?? 0) || (value as number) > (definition.max ?? Number.MAX_SAFE_INTEGER))) throw new Error(`${key} is out of range`);
  if (definition.valueType === "object") {
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${key} must be an object`);
    if (Object.keys(value).some((field) => field !== "anthropicExtraUsage") || ((value as { anthropicExtraUsage?: unknown }).anthropicExtraUsage !== undefined && typeof (value as { anthropicExtraUsage?: unknown }).anthropicExtraUsage !== "boolean")) throw new Error("warnings must be a closed warning object");
  }
}

function boundedErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.length === 0) return "Settings error details omitted";
  return message.length <= 2_048 ? message : `${message.slice(0, 2_047)}…`;
}
