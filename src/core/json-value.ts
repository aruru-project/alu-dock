export const MAX_JSON_VALUE_DEPTH = 8;
export const MAX_JSON_OBJECT_KEYS = 100;
export const MAX_JSON_ARRAY_ITEMS = 200;

export type JsonScalar = string | number | boolean | null;
export type JsonValue = JsonScalar | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };
