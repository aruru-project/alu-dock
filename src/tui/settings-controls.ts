import type { AutocompleteItem } from "@earendil-works/pi-tui";

import type { SettingDto, SettingUpdate } from "../core/config-projection.js";
import { MODEL_SPEED_TIERS, parseModelSpeedSelection } from "../core/model-speed.js";

export const SPEED_USAGE = "Use /speed standard|fast|ultrafast [all], or /speed inherit to follow the parent (standard without a shared choice).";

export function settingName(setting: SettingDto): string {
  return setting.key === "modelSpeed" ? "Model speed" : setting.key;
}

export function formatSettingValue(value: SettingDto["value"]): string {
  if (value === null) return "follow parent, otherwise standard";
  if (typeof value === "object" && "tier" in value) return `${value.tier} · ${value.scope === "all" ? "current and child Works" : "current Work only"}`;
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

export function settingChoiceValue(setting: SettingDto): string | undefined {
  if (setting.key === "modelSpeed") return setting.value ? `${setting.value.tier}${setting.value.scope === "all" ? " all" : ""}` : "inherit";
  if (setting.valueType === "object") {
    const enabled = (setting.value as { anthropicExtraUsage?: boolean }).anthropicExtraUsage;
    return enabled !== false ? "true" : "false";
  }
  return typeof setting.value === "string" || typeof setting.value === "boolean"
    ? String(setting.value)
    : undefined;
}

export function settingValueChoices(setting: SettingDto, child = false): Array<{ value: string; label: string; description?: string }> {
  if (setting.key === "modelSpeed") return [
    ...MODEL_SPEED_TIERS.filter(tier => setting.allowedValues?.includes(tier)).flatMap(tier => [
      { value: tier, label: `${tier === "standard" ? "Standard" : tier === "fast" ? "Fast" : "Ultrafast"} · current Work only` },
      { value: `${tier} all`, label: `${tier === "standard" ? "Standard" : tier === "fast" ? "Fast" : "Ultrafast"} · current and child Works`, description: "Includes running and future children without their own choice" },
    ]),
    { value: "inherit", label: child ? "Follow parent again" : "Default (standard)", description: child ? "Use the parent's shared choice, otherwise standard" : "Clear this Work's own choice" },
  ];
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
  if (setting.key === "modelSpeed") {
    const words = rawValue.trim().split(/\s+/u);
    const [tier, scope] = words;
    try {
      const selection = rawValue === "inherit" ? null
        : words.length <= 2 && (MODEL_SPEED_TIERS.includes(tier as typeof MODEL_SPEED_TIERS[number]) || tier === "off") && (scope === undefined || scope === "all")
          ? { tier: tier === "off" ? "standard" : tier, scope: scope ?? "work" }
          : JSON.parse(rawValue) as unknown;
      const parsed = parseModelSpeedSelection(selection);
      if (parsed && !setting.allowedValues?.includes(parsed.tier)) return undefined;
      return { key: "modelSpeed", value: parsed };
    } catch { return undefined; }
  }
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

export function settingCompletions(settings: SettingDto[], prefix: string, child = false): AutocompleteItem[] {
  const separator = prefix.indexOf(" ");
  if (separator < 0) {
    return settings
      .filter((setting) => setting.key.startsWith(prefix))
      .map((setting) => ({ value: setting.key, label: settingName(setting), description: `${formatSettingValue(setting.value)}${setting.writable ? "" : " · read-only"}` }));
  }
  const key = prefix.slice(0, separator);
  const valuePrefix = prefix.slice(separator + 1);
  const setting = settings.find((candidate) => candidate.key === key);
  if (!setting?.writable) return [];
  return settingValueChoices(setting, child)
    .filter((choice) => choice.value.startsWith(valuePrefix))
    .map((choice) => ({ value: `${key} ${choice.value}`, label: choice.label, description: choice.description }));
}
