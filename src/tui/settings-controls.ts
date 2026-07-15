import type { AutocompleteItem } from "@earendil-works/pi-tui";

import type { SettingDto, SettingUpdate } from "../core/config-projection.js";

export function formatSettingValue(value: SettingDto["value"]): string {
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

export function settingChoiceValue(setting: SettingDto): string | undefined {
  if (setting.valueType === "object") {
    const enabled = (setting.value as { anthropicExtraUsage?: boolean }).anthropicExtraUsage;
    return enabled !== false ? "true" : "false";
  }
  return typeof setting.value === "string" || typeof setting.value === "boolean"
    ? String(setting.value)
    : undefined;
}

export function settingValueChoices(setting: SettingDto): Array<{ value: string; label: string; description?: string }> {
  if (setting.valueType === "boolean") return [
    { value: "true", label: "true" },
    { value: "false", label: "false" },
  ];
  if (setting.valueType === "enum") return (setting.allowedValues ?? []).map((value) => ({ value: String(value), label: String(value) }));
  if (setting.valueType === "object") return [
    { value: "true", label: "anthropicExtraUsage: true" },
    { value: "false", label: "anthropicExtraUsage: false" },
  ];
  return [{ value: String(setting.value), label: String(setting.value), description: `${setting.min ?? 0}..${setting.max ?? "∞"}` }];
}

export function parseSettingCommandValue(setting: SettingDto, rawValue: string): SettingUpdate | undefined {
  if (!setting.writable) return undefined;
  let value: unknown;
  if (setting.valueType === "boolean") {
    if (rawValue === "true" || rawValue === "on") value = true;
    else if (rawValue === "false" || rawValue === "off") value = false;
    else return undefined;
  } else if (setting.valueType === "enum") {
    if (!setting.allowedValues?.includes(rawValue)) return undefined;
    value = rawValue;
  } else if (setting.valueType === "integer") {
    if (!/^\d+$/u.test(rawValue)) return undefined;
    const parsed = Number(rawValue);
    if (!Number.isSafeInteger(parsed) || parsed < (setting.min ?? 0) || parsed > (setting.max ?? Number.MAX_SAFE_INTEGER)) return undefined;
    value = parsed;
  } else {
    if (rawValue === "true" || rawValue === "on") value = { anthropicExtraUsage: true };
    else if (rawValue === "false" || rawValue === "off") value = { anthropicExtraUsage: false };
    else {
      try {
        const parsed = JSON.parse(rawValue) as unknown;
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
        const record = parsed as Record<string, unknown>;
        if (Object.keys(record).some((key) => key !== "anthropicExtraUsage") || (record.anthropicExtraUsage !== undefined && typeof record.anthropicExtraUsage !== "boolean")) return undefined;
        value = { ...(record.anthropicExtraUsage === undefined ? {} : { anthropicExtraUsage: record.anthropicExtraUsage }) };
      } catch { return undefined; }
    }
  }
  return { key: setting.key, value } as SettingUpdate;
}

export function settingCompletions(settings: SettingDto[], prefix: string): AutocompleteItem[] {
  const separator = prefix.indexOf(" ");
  if (separator < 0) {
    return settings
      .filter((setting) => setting.key.startsWith(prefix))
      .map((setting) => ({ value: setting.key, label: setting.key, description: `${formatSettingValue(setting.value)}${setting.writable ? "" : " · read-only"}` }));
  }
  const key = prefix.slice(0, separator);
  const valuePrefix = prefix.slice(separator + 1);
  const setting = settings.find((candidate) => candidate.key === key);
  if (!setting?.writable) return [];
  return settingValueChoices(setting)
    .filter((choice) => choice.value.startsWith(valuePrefix))
    .map((choice) => ({ value: `${key} ${choice.value}`, label: choice.label, description: choice.description }));
}
