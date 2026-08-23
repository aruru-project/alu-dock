import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readdir, readFile, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import {
  WORKER_INCIDENT_STDERR_MAX_BYTES,
  type WorkerIncidentEvidence,
  type WorkerIncidentRecorder,
} from "../core/worker-incident.js";
import { hardenWindowsPrivatePath, syncPrivateDirectory } from "../platform/private-state.js";

const WORKER_INCIDENT_SCHEMA = 1 as const;
const WORKER_INCIDENT_MAX_RECORDS = 50;
const WORKER_INCIDENT_MAX_FILE_BYTES = WORKER_INCIDENT_STDERR_MAX_BYTES * 6 + 64 * 1024;

export interface WorkerIncidentRecord extends WorkerIncidentEvidence {
  schemaVersion: 1;
  machineName: string;
}

export function workerIncidentStoreRoot(catalogPath: string): string {
  return join(dirname(resolve(catalogPath)), "diagnostics", "worker-incidents");
}

export class WorkerIncidentStore {
  readonly root: string;
  private tail = Promise.resolve();

  constructor(root: string) {
    this.root = resolve(root);
  }

  recorder(machineName: string): WorkerIncidentRecorder {
    const checkedMachineName = boundedOutput(machineName, 256, "Machine name");
    return {
      record: (evidence) => this.enqueue(() => this.record(checkedMachineName, evidence)),
    };
  }

  async list(limit = WORKER_INCIDENT_MAX_RECORDS): Promise<WorkerIncidentRecord[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > WORKER_INCIDENT_MAX_RECORDS) {
      throw new Error(`Diagnostic limit must be between 1 and ${WORKER_INCIDENT_MAX_RECORDS}`);
    }
    await this.ensureRoot();
    const names = (await readdir(this.root, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && /^\d+-[0-9a-f-]+\.json$/u.test(entry.name))
      .map((entry) => entry.name)
      .sort()
      .reverse()
      .slice(0, limit);
    return Promise.all(names.map((name) => this.readRecord(join(this.root, name))));
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation, operation);
    this.tail = result.then(() => {}, () => {});
    return result;
  }

  private async record(machineName: string, evidence: WorkerIncidentEvidence): Promise<void> {
    await this.ensureRoot();
    const incidentId = randomUUID();
    const occurredAt = checkedTimestamp(evidence.occurredAt);
    const stderrBytes = Buffer.from(evidence.stderrTail, "utf8");
    const stderrTail = stderrBytes.length <= WORKER_INCIDENT_STDERR_MAX_BYTES
      ? evidence.stderrTail
      : stderrBytes.subarray(stderrBytes.length - WORKER_INCIDENT_STDERR_MAX_BYTES).toString("utf8");
    const record: WorkerIncidentRecord = {
      schemaVersion: WORKER_INCIDENT_SCHEMA,
      machineName,
      instanceId: boundedOutput(evidence.instanceId, 128, "Instance identity"),
      ...(evidence.workName === undefined ? {} : { workName: boundedOutput(evidence.workName, 256, "Work name") }),
      runtimeGeneration: positiveInteger(evidence.runtimeGeneration, "Runtime generation"),
      workerIncarnation: boundedOutput(evidence.workerIncarnation, 128, "Worker incarnation"),
      occurredAt,
      cause: boundedOutput(evidence.cause, 2_048, "Worker failure"),
      ...(evidence.exitCode === undefined ? {} : { exitCode: integer(evidence.exitCode, "Worker exit code") }),
      ...(evidence.signal === undefined ? {} : { signal: boundedOutput(evidence.signal, 64, "Worker exit signal") }),
      stderrTail,
      stderrTruncated: evidence.stderrTruncated || stderrBytes.length > WORKER_INCIDENT_STDERR_MAX_BYTES,
      platform: evidence.platform,
      architecture: boundedOutput(evidence.architecture, 64, "Architecture"),
      nodeVersion: boundedOutput(evidence.nodeVersion, 64, "Node version"),
    };
    const fileName = `${Date.parse(occurredAt)}-${incidentId}.json`;
    const target = join(this.root, fileName);
    const temporary = `${target}.tmp-${process.pid}`;
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await syncPrivateDirectory(this.root, () => rename(temporary, target));
      await hardenWindowsPrivatePath(target, false);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
    await this.prune();
  }

  private async ensureRoot(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") await chmod(this.root, 0o700);
    await hardenWindowsPrivatePath(this.root, true);
  }

  private async prune(): Promise<void> {
    const entries = await readdir(this.root, { withFileTypes: true });
    const staleTemporary = entries
      .filter((entry) => entry.isFile() && /^\d+-[0-9a-f-]+\.json\.tmp-\d+$/u.test(entry.name))
      .map((entry) => entry.name);
    await Promise.all(staleTemporary.map((name) => rm(join(this.root, name), { force: true })));
    const names = entries
      .filter((entry) => entry.isFile() && /^\d+-[0-9a-f-]+\.json$/u.test(entry.name))
      .map((entry) => entry.name)
      .sort();
    const excess = names.slice(0, Math.max(0, names.length - WORKER_INCIDENT_MAX_RECORDS));
    await Promise.all(excess.map((name) => rm(join(this.root, name), { force: true })));
  }

  private async readRecord(path: string): Promise<WorkerIncidentRecord> {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > WORKER_INCIDENT_MAX_FILE_BYTES) throw new Error("A saved Worker diagnostic is invalid");
    return parseRecord(JSON.parse(await readFile(path, "utf8")) as unknown);
  }
}

function parseRecord(input: unknown): WorkerIncidentRecord {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("A saved Worker diagnostic is invalid");
  const value = input as Record<string, unknown>;
  if (value.schemaVersion !== WORKER_INCIDENT_SCHEMA) throw new Error("A saved Worker diagnostic uses an unsupported format");
  return {
    schemaVersion: WORKER_INCIDENT_SCHEMA,
    machineName: bounded(value.machineName, 256, "Machine name"),
    instanceId: bounded(value.instanceId, 128, "Instance identity"),
    ...(value.workName === undefined ? {} : { workName: bounded(value.workName, 256, "Work name") }),
    runtimeGeneration: positiveInteger(value.runtimeGeneration, "Runtime generation"),
    workerIncarnation: bounded(value.workerIncarnation, 128, "Worker incarnation"),
    occurredAt: checkedTimestamp(value.occurredAt),
    cause: bounded(value.cause, 2_048, "Worker failure"),
    ...(value.exitCode === undefined ? {} : { exitCode: integer(value.exitCode, "Worker exit code") }),
    ...(value.signal === undefined ? {} : { signal: bounded(value.signal, 64, "Worker exit signal") }),
    stderrTail: bounded(value.stderrTail, WORKER_INCIDENT_STDERR_MAX_BYTES, "Worker error output", true),
    stderrTruncated: value.stderrTruncated === true,
    platform: bounded(value.platform, 32, "Platform") as NodeJS.Platform,
    architecture: bounded(value.architecture, 64, "Architecture"),
    nodeVersion: bounded(value.nodeVersion, 64, "Node version"),
  };
}

function boundedOutput(value: string, limit: number, label: string): string {
  let output = "";
  let bytes = 0;
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (bytes + characterBytes > limit) break;
    output += character;
    bytes += characterBytes;
  }
  if (output.length < 1) throw new Error(`${label} is invalid`);
  return output;
}

function bounded(value: unknown, limit: number, label: string, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && value.length < 1) || Buffer.byteLength(value, "utf8") > limit) throw new Error(`${label} is invalid`);
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw new Error(`${label} is invalid`);
  return Number(value);
}

function integer(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value)) throw new Error(`${label} is invalid`);
  return Number(value);
}

function checkedTimestamp(value: unknown): string {
  const timestamp = bounded(value, 64, "Incident time");
  if (!Number.isFinite(Date.parse(timestamp))) throw new Error("Incident time is invalid");
  return timestamp;
}
