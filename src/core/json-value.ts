import { truncateWithEllipsis } from "./bounded-text.js";

export const MAX_JSON_VALUE_DEPTH = 8;
export const MAX_JSON_OBJECT_KEYS = 100;
export const MAX_JSON_ARRAY_ITEMS = 200;

export type JsonScalar = string | number | boolean | null;
export type JsonValue = JsonScalar | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export const MAX_JSON_STRING_CHARS = 8_000;
export const MAX_JSON_NODES = 2_000;
export const MAX_JSON_BYTES = 256_000;
export const MAX_JSON_OMITTED_FIELDS = 200;

/** Project arbitrary runtime values into the bounded JSON shape used on Dock wires. */
export function projectJsonObject(input: unknown): { value: JsonObject; omittedFields: string[] } {
  const omittedFields: string[] = [];
  const omittedSet = new Set<string>();
  const seen = new WeakSet<object>();
  let projectedNodes = 0;
  let projectedBytes = 0;
  let budgetExhausted = false;
  const omit = (path: string): void => {
    const safePath = (path || "/").slice(0, 512);
    if (omittedSet.has(safePath) || omittedFields.length >= MAX_JSON_OMITTED_FIELDS) return;
    omittedSet.add(safePath);
    omittedFields.push(safePath);
  };
  const reserve = (bytes: number, path: string): boolean => {
    if (budgetExhausted || projectedBytes + bytes > MAX_JSON_BYTES) {
      budgetExhausted = true;
      omit(path);
      return false;
    }
    projectedBytes += bytes;
    return true;
  };
  const project = (value: unknown, path: string, depth: number): JsonValue | undefined => {
    if (budgetExhausted || projectedNodes >= MAX_JSON_NODES) {
      budgetExhausted = true;
      omit(path);
      return undefined;
    }
    projectedNodes += 1;
    if (typeof value === "string") {
      const projected = truncateWithEllipsis(value, MAX_JSON_STRING_CHARS) ?? "";
      return reserve(Buffer.byteLength(JSON.stringify(projected), "utf8"), path) ? projected : undefined;
    }
    if (value === null || typeof value === "boolean") {
      return reserve(value === null ? 4 : value ? 4 : 5, path) ? value : undefined;
    }
    if (typeof value === "number") {
      if (!Number.isFinite(value)) { omit(path); return undefined; }
      return reserve(Buffer.byteLength(JSON.stringify(value), "utf8"), path) ? value : undefined;
    }
    if (typeof value !== "object" || value === null || typeof value === "function" || typeof value === "symbol" || typeof value === "bigint") {
      omit(path);
      return undefined;
    }
    if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
      omit(path);
      return undefined;
    }
    if (depth >= MAX_JSON_VALUE_DEPTH || seen.has(value) || !reserve(2, path)) {
      omit(path);
      return undefined;
    }
    seen.add(value);
    if (Array.isArray(value)) {
      const result: JsonValue[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const itemPath = `${path}/${index}`;
        if (index >= MAX_JSON_ARRAY_ITEMS || budgetExhausted || projectedNodes >= MAX_JSON_NODES) { omit(itemPath); break; }
        if (result.length > 0 && !reserve(1, itemPath)) break;
        let sourceItem: unknown;
        try { sourceItem = value[index]; }
        catch { omit(itemPath); continue; }
        const item = project(sourceItem, itemPath, depth + 1);
        if (item !== undefined) result.push(item);
      }
      return result;
    }
    const result: JsonObject = {};
    let index = 0;
    for (const key in value as Record<string, unknown>) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
      const itemPath = `${path}/${escapeJsonPointer(key.slice(0, 256))}`;
      if (index >= MAX_JSON_OBJECT_KEYS || budgetExhausted || projectedNodes >= MAX_JSON_NODES) { omit(itemPath); break; }
      index += 1;
      if (key.length < 1 || key.length > 256 || /[\u0000-\u001f\u007f-\u009f]/u.test(key)) { omit(itemPath); continue; }
      const separatorBytes = Object.keys(result).length > 0 ? 1 : 0;
      if (!reserve(separatorBytes + Buffer.byteLength(JSON.stringify(key), "utf8") + 1, itemPath)) break;
      let sourceItem: unknown;
      try { sourceItem = (value as Record<string, unknown>)[key]; }
      catch { omit(itemPath); continue; }
      const projected = project(sourceItem, itemPath, depth + 1);
      if (projected !== undefined) Object.defineProperty(result, key, { value: projected, enumerable: true, configurable: true, writable: true });
    }
    return result;
  };
  const value = project(input, "", 0);
  return { value: isJsonObject(value) ? value : {}, omittedFields };
}

/** Strictly validate and clone an opaque JSON object at a persistence/process boundary. */
export function cloneBoundedJsonObject(input: unknown, label = "JSON object"): JsonObject {
  let nodes = 0;
  const visit = (value: unknown, depth: number, field: string): JsonValue => {
    nodes += 1;
    if (nodes > MAX_JSON_NODES) throw new Error(`${label} has too many values`);
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "number") {
      if (!Number.isFinite(value)) throw new Error(`${field} must be a finite number`);
      return value;
    }
    if (typeof value === "string") {
      if (value.length > MAX_JSON_STRING_CHARS) throw new Error(`${field} is too long`);
      return value;
    }
    if (typeof value !== "object" || value === null) throw new Error(`${field} is not JSON`);
    if (depth >= MAX_JSON_VALUE_DEPTH) throw new Error(`${field} exceeds the JSON depth limit`);
    if (Array.isArray(value)) {
      if (value.length > MAX_JSON_ARRAY_ITEMS) throw new Error(`${field} has too many items`);
      return value.map((item, index) => visit(item, depth + 1, `${field}[${index}]`));
    }
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length > MAX_JSON_OBJECT_KEYS) throw new Error(`${field} has too many keys`);
    const result: JsonObject = {};
    for (const [key, item] of entries) {
      if (key.length < 1 || key.length > 256 || /[\u0000-\u001f\u007f-\u009f]/u.test(key)) throw new Error(`${field} has an invalid key`);
      Object.defineProperty(result, key, { value: visit(item, depth + 1, `${field}.${key}`), enumerable: true, configurable: true, writable: true });
    }
    return result;
  };
  if (input === null || typeof input !== "object" || Array.isArray(input)) throw new Error(`${label} must be a JSON object`);
  const result = visit(input, 0, label) as JsonObject;
  if (Buffer.byteLength(JSON.stringify(result), "utf8") > MAX_JSON_BYTES) throw new Error(`${label} is too large`);
  return result;
}

function escapeJsonPointer(value: string): string { return value.replace(/~/g, "~0").replace(/\//g, "~1"); }
function isJsonObject(value: JsonValue | undefined): value is JsonObject { return value !== undefined && value !== null && typeof value === "object" && !Array.isArray(value); }
