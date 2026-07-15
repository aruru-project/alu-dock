export type JsonScalar = string | number | boolean | null;
export type JsonValue = JsonScalar | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export interface SourceDto {
  kind: "built-in" | "extension" | "skill" | "prompt";
  path?: string;
  package?: string;
}
export interface ToolDto { name: string; description: string; active: boolean; source?: SourceDto; parameterSchema?: JsonObject }
export interface CommandDto { name: string; description?: string; source: SourceDto; argumentCompletions: boolean }
export interface ResourceDto { kind: "extension" | "skill" | "prompt" | "context"; name: string; path?: string; source?: SourceDto }
export interface DiagnosticDto { severity: "info" | "warning" | "error"; message: string; source?: string }

/** Locale-independent canonical ordering shared by projection producers and wire validators. */
export function compareCanonicalText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function compareSourceDtos(left: SourceDto, right: SourceDto): number {
  return compareCanonicalText(left.kind, right.kind)
    || compareCanonicalText(left.package ?? "", right.package ?? "")
    || compareCanonicalText(left.path ?? "", right.path ?? "");
}

export function compareToolDtos(left: ToolDto, right: ToolDto): number {
  return compareCanonicalText(left.name, right.name)
    || compareSourceDtos(left.source ?? { kind: "built-in" }, right.source ?? { kind: "built-in" })
    || compareCanonicalText(left.description, right.description)
    || Number(left.active) - Number(right.active)
    || compareCanonicalText(JSON.stringify(left.parameterSchema ?? {}), JSON.stringify(right.parameterSchema ?? {}));
}

export function compareCommandDtos(left: CommandDto, right: CommandDto): number {
  return compareCanonicalText(left.name, right.name)
    || compareSourceDtos(left.source, right.source)
    || compareCanonicalText(left.description ?? "", right.description ?? "")
    || Number(left.argumentCompletions) - Number(right.argumentCompletions);
}

export function compareResourceDtos(left: ResourceDto, right: ResourceDto): number {
  return compareCanonicalText(left.kind, right.kind)
    || compareCanonicalText(left.name, right.name)
    || compareCanonicalText(left.path ?? "", right.path ?? "")
    || compareSourceDtos(left.source ?? { kind: "built-in" }, right.source ?? { kind: "built-in" });
}

export function compareDiagnosticDtos(left: DiagnosticDto, right: DiagnosticDto): number {
  return compareCanonicalText(left.severity, right.severity)
    || compareCanonicalText(left.message, right.message)
    || compareCanonicalText(left.source ?? "", right.source ?? "");
}

export interface SettingValueMap {
  autoCompaction: boolean;
  compactionReserveTokens: number;
  compactionKeepRecentTokens: number;
  autoRetry: boolean;
  enableSkillCommands: boolean;
  hideThinking: boolean;
  showCacheMissNotices: boolean;
  showHardwareCursor: boolean;
  clearOnShrink: boolean;
  showTerminalProgress: boolean;
  quietStartup: boolean;
  collapseChangelog: boolean;
  enableInstallTelemetry: boolean;
  steeringMode: "all" | "one-at-a-time";
  followUpMode: "all" | "one-at-a-time";
  transport: "auto" | "sse" | "websocket" | "websocket-cached";
  doubleEscapeAction: "fork" | "tree" | "none";
  treeFilterMode: "default" | "no-tools" | "user-only" | "labeled-only" | "all";
  defaultProjectTrust: "ask" | "always" | "never";
  httpIdleTimeoutMs: number;
  editorPaddingX: number;
  outputPad: 0 | 1;
  autocompleteMaxVisible: number;
  warnings: { anthropicExtraUsage?: boolean };
}
export type SettingKey = keyof SettingValueMap;
export type ReadOnlySettingKey = "compactionReserveTokens" | "compactionKeepRecentTokens";
export type WritableSettingKey = Exclude<SettingKey, ReadOnlySettingKey>;
export type SettingUpdate = { [K in WritableSettingKey]: { key: K; value: SettingValueMap[K] } }[WritableSettingKey];
export type SettingSource = "global" | "project" | "effective";
export type SettingDto = { [K in SettingKey]: {
  key: K;
  value: SettingValueMap[K];
  source: SettingSource;
  writable: boolean;
  valueType: "boolean" | "enum" | "integer" | "object";
  allowedValues?: Array<string | number | boolean>;
  min?: number;
  max?: number;
  reloadRequired: boolean;
  hostRestartRequired: boolean;
} }[SettingKey];

export interface SettingDefinition {
  valueType: "boolean" | "enum" | "integer" | "object";
  allowedValues?: readonly (string | number | boolean)[];
  min?: number;
  max?: number;
  reloadRequired: boolean;
  hostRestartRequired: boolean;
  writable: boolean;
  /** Public Settings shape path used only to report the source of the effective value. */
  sourcePath: readonly string[];
}

const booleanDefinition = (sourcePath: readonly string[], reloadRequired = false): SettingDefinition => Object.freeze({
  valueType: "boolean", reloadRequired, hostRestartRequired: false, writable: true, sourcePath: Object.freeze([...sourcePath]),
});
const enumDefinition = (sourcePath: readonly string[], allowedValues: readonly string[]): SettingDefinition => Object.freeze({
  valueType: "enum", allowedValues: Object.freeze([...allowedValues]), reloadRequired: false, hostRestartRequired: false, writable: true, sourcePath: Object.freeze([...sourcePath]),
});
const integerDefinition = (sourcePath: readonly string[], min: number, max: number, hostRestartRequired = false): SettingDefinition => Object.freeze({
  valueType: "integer", min, max, reloadRequired: false, hostRestartRequired, writable: true, sourcePath: Object.freeze([...sourcePath]),
});

/** Exhaustive frozen metadata for the Stage 3 general-settings projection. */
export const SETTING_DEFINITIONS: { readonly [K in SettingKey]: SettingDefinition } = Object.freeze({
  autoCompaction: booleanDefinition(["compaction", "enabled"]),
  compactionReserveTokens: Object.freeze({ valueType: "integer", min: 0, max: 2_147_483_647, reloadRequired: false, hostRestartRequired: false, writable: false, sourcePath: Object.freeze(["compaction", "reserveTokens"]) }),
  compactionKeepRecentTokens: Object.freeze({ valueType: "integer", min: 0, max: 2_147_483_647, reloadRequired: false, hostRestartRequired: false, writable: false, sourcePath: Object.freeze(["compaction", "keepRecentTokens"]) }),
  autoRetry: booleanDefinition(["retry", "enabled"]),
  enableSkillCommands: booleanDefinition(["enableSkillCommands"], true),
  hideThinking: booleanDefinition(["hideThinkingBlock"]),
  showCacheMissNotices: booleanDefinition(["showCacheMissNotices"]),
  showHardwareCursor: booleanDefinition(["showHardwareCursor"]),
  clearOnShrink: booleanDefinition(["terminal", "clearOnShrink"]),
  showTerminalProgress: booleanDefinition(["terminal", "showTerminalProgress"]),
  quietStartup: booleanDefinition(["quietStartup"]),
  collapseChangelog: booleanDefinition(["collapseChangelog"]),
  enableInstallTelemetry: booleanDefinition(["enableInstallTelemetry"]),
  steeringMode: enumDefinition(["steeringMode"], ["all", "one-at-a-time"]),
  followUpMode: enumDefinition(["followUpMode"], ["all", "one-at-a-time"]),
  transport: enumDefinition(["transport"], ["auto", "sse", "websocket", "websocket-cached"]),
  doubleEscapeAction: enumDefinition(["doubleEscapeAction"], ["fork", "tree", "none"]),
  treeFilterMode: enumDefinition(["treeFilterMode"], ["default", "no-tools", "user-only", "labeled-only", "all"]),
  defaultProjectTrust: enumDefinition(["defaultProjectTrust"], ["ask", "always", "never"]),
  httpIdleTimeoutMs: integerDefinition(["httpIdleTimeoutMs"], 0, 2_147_483_647, true),
  editorPaddingX: integerDefinition(["editorPaddingX"], 0, 3),
  outputPad: integerDefinition(["outputPad"], 0, 1),
  autocompleteMaxVisible: integerDefinition(["autocompleteMaxVisible"], 3, 20),
  warnings: Object.freeze({ valueType: "object", reloadRequired: false, hostRestartRequired: false, writable: true, sourcePath: Object.freeze(["warnings", "anthropicExtraUsage"]) }),
});

export const SETTING_KEYS = Object.freeze(Object.keys(SETTING_DEFINITIONS) as SettingKey[]);
