/** A tool capability ceiling, not a filesystem or process sandbox. */
export interface WorkerToolPolicy { allowedTools: string[] }

export function parseWorkerToolPolicy(value: unknown): WorkerToolPolicy | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).some((key) => key !== "allowedTools")) {
    throw new Error("Worker tool permissions must contain an allowedTools list.");
  }
  const names = (value as { allowedTools?: unknown }).allowedTools;
  if (!Array.isArray(names) || names.some((name) => typeof name !== "string"
    || name.length === 0 || name.length > 256 || name.trim() !== name
    || /[\s\u0000-\u001f\u007f*]/u.test(name) || /^[+-]/u.test(name))) {
    throw new Error("Worker tool permissions need exact tool names, not patterns or selection modifiers.");
  }
  if (new Set(names).size !== names.length) throw new Error("Worker tool permissions contain duplicate names.");
  return { allowedTools: [...names] as string[] };
}
