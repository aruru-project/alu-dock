import { createHash, randomBytes, randomUUID, X509Certificate } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import type { InstanceSnapshot } from "../core/instance-dto.js";
import { generateHostIdentity, parseHostTlsIdentity, type HostTlsIdentity } from "./remote-access-state.js";
import { parseInstanceSnapshot } from "./protocol.js";
import { MAX_DURABLE_CATALOG_BYTES } from "./durable-catalog-store.js";
import { hardenWindowsPrivatePath, syncPrivateDirectory } from "../platform/private-state.js";

const MACHINE_STATE_SCHEMA = 1 as const;
const JOIN_LIFETIME_MS = 10 * 60_000;
const SAFE_ID = /^[0-9a-f-]{36}$/u;
const SAFE_TOKEN = /^[0-9a-f]{64}$/u;
const SAFE_FINGERPRINT = /^[0-9a-f]{64}$/u;

export interface MachineJoinFile {
  schemaVersion: 1;
  token: string;
  mainCertificatePem: string;
  mainFingerprint: string;
  expiresAt: string;
}

export interface MachineRouteRecord {
  mainInstanceId: string;
  nativeInstanceId: string;
  snapshot: InstanceSnapshot;
}

export interface MachineRouteRetirement {
  nativeInstanceId: string;
  runtimeGeneration: number;
}

export interface TrustedSubHostRecord {
  id: string;
  name: string;
  certificatePem: string;
  fingerprint: string;
  joinedAt: string;
  routes: MachineRouteRecord[];
  retiredRoutes: MachineRouteRetirement[];
}

interface PendingJoinRecord { tokenHash: string; expiresAt: string }
interface TrustedSubHostIndexRecord {
  id: string;
  name: string;
  certificatePem: string;
  fingerprint: string;
  joinedAt: string;
}
interface MainMachineFile {
  schemaVersion: 1;
  revision: number;
  mainId: string;
  mainName: string;
  identity: HostTlsIdentity;
  pendingJoins: PendingJoinRecord[];
  machines: TrustedSubHostIndexRecord[];
}
interface MachineRouteFile {
  schemaVersion: 1;
  machineId: string;
  routes: MachineRouteRecord[];
  retiredRoutes: MachineRouteRetirement[];
}

export interface SubHostUpstreamRecord {
  schemaVersion: 1;
  machineId: string;
  machineName: string;
  identity: HostTlsIdentity;
  mainCertificatePem: string;
  mainFingerprint: string;
  joinToken?: string;
}

export function machineStateRoot(catalogPath: string): string {
  return join(dirname(resolve(catalogPath)), "machines");
}

export class MainMachineState {
  readonly root: string;
  readonly path: string;
  private value: MainMachineFile | undefined;
  private readonly routeValues = new Map<string, MachineRouteFile>();
  private tail = Promise.resolve();

  constructor(root: string, private readonly configuredMainName = "Main") {
    this.root = resolve(root);
    this.path = join(this.root, "main.json");
  }

  async initialize(): Promise<void> {
    if (this.value) return;
    await ensureDirectory(this.root);
    const stored = await readJson(this.path);
    if (stored !== undefined) this.value = parseMainFile(stored);
    else {
      this.value = {
        schemaVersion: MACHINE_STATE_SCHEMA,
        revision: 0,
        mainId: randomUUID(),
        mainName: checkedName(this.configuredMainName),
        identity: await generateHostIdentity(),
        pendingJoins: [],
        machines: [],
      };
      await this.persistMain();
    }
    for (const machine of this.current().machines) {
      const routeFile = await readJson(this.routePath(machine.id));
      this.routeValues.set(machine.id, routeFile === undefined
        ? { schemaVersion: 1, machineId: machine.id, routes: [], retiredRoutes: [] }
        : parseMachineRouteFile(routeFile, machine.id));
    }
    assertGloballyUniqueMainRouteIds(this.routeValues);
  }

  async identity(): Promise<HostTlsIdentity> { await this.initialize(); return structuredClone(this.current().identity); }
  async main(): Promise<{ id: string; name: string; revision: number }> { await this.initialize(); const value = this.current(); return { id: value.mainId, name: value.mainName, revision: value.revision }; }
  async list(): Promise<TrustedSubHostRecord[]> { await this.initialize(); return this.current().machines.map((item) => this.trustedRecord(item)); }
  async get(id: string): Promise<TrustedSubHostRecord | undefined> { await this.initialize(); const item = this.current().machines.find((candidate) => candidate.id === id); return item ? this.trustedRecord(item) : undefined; }

  async createJoin(now = new Date()): Promise<MachineJoinFile> {
    return this.mutateMain((value) => {
      const token = randomBytes(32).toString("hex");
      const expiresAt = new Date(now.getTime() + JOIN_LIFETIME_MS).toISOString();
      value.pendingJoins = value.pendingJoins.filter((item) => Date.parse(item.expiresAt) > now.getTime());
      value.pendingJoins.push({ tokenHash: tokenHash(token), expiresAt });
      return { schemaVersion: 1, token, mainCertificatePem: value.identity.certificatePem, mainFingerprint: value.identity.fingerprint, expiresAt };
    });
  }

  async acceptJoin(input: { token: string; machineId: string; machineName: string; certificatePem: string }, now = new Date()): Promise<TrustedSubHostRecord> {
    const joined = await this.mutateMain((value) => {
      const hash = tokenHash(input.token);
      const index = value.pendingJoins.findIndex((item) => item.tokenHash === hash && Date.parse(item.expiresAt) > now.getTime());
      if (index < 0) throw new Error("This SubHost join file is expired or has already been used");
      value.pendingJoins.splice(index, 1);
      if (value.machines.some((item) => item.id === input.machineId)) throw new Error("This SubHost identity is already joined");
      const certificate = new X509Certificate(input.certificatePem);
      const record: TrustedSubHostIndexRecord = {
        id: checkedId(input.machineId, "machine ID"),
        name: checkedName(input.machineName),
        certificatePem: certificate.toString(),
        fingerprint: certificate.fingerprint256.replaceAll(":", "").toLowerCase(),
        joinedAt: now.toISOString(),
      };
      value.machines.push(record);
      return structuredClone(record);
    });
    this.routeValues.set(joined.id, { schemaVersion: 1, machineId: joined.id, routes: [], retiredRoutes: [] });
    return this.trustedRecord(joined);
  }

  async retireRoute(mainInstanceId: string, authoritativeRuntimeGeneration: number): Promise<MachineRouteRecord | undefined> {
    if (!Number.isSafeInteger(authoritativeRuntimeGeneration) || authoritativeRuntimeGeneration < 0) throw new Error("Retired route runtime generation is invalid");
    for (const machine of await this.list()) {
      const removed = await this.mutateRoute(machine.id, (candidate) => {
        const index = candidate.routes.findIndex((route) => route.mainInstanceId === mainInstanceId);
        if (index < 0) return undefined;
        const [route] = candidate.routes.splice(index, 1);
        if (route) {
          const retirement = candidate.retiredRoutes.find((item) => item.nativeInstanceId === route.nativeInstanceId);
          const runtimeGeneration = Math.max(authoritativeRuntimeGeneration, route.snapshot.runtimeGeneration);
          if (retirement) retirement.runtimeGeneration = Math.max(retirement.runtimeGeneration, runtimeGeneration);
          else candidate.retiredRoutes.push({ nativeInstanceId: route.nativeInstanceId, runtimeGeneration });
        }
        return route;
      });
      if (removed) return removed;
    }
    return undefined;
  }

  async removeRoute(mainInstanceId: string): Promise<MachineRouteRecord | undefined> {
    for (const machine of await this.list()) {
      const removed = await this.mutateRoute(machine.id, (candidate) => {
        const index = candidate.routes.findIndex((route) => route.mainInstanceId === mainInstanceId);
        return index < 0 ? undefined : candidate.routes.splice(index, 1)[0];
      });
      if (removed) return removed;
    }
    return undefined;
  }

  async updateMachine(
    machineId: string,
    update: (machine: TrustedSubHostRecord, facts: { usedMainInstanceIds: ReadonlySet<string> }) => void,
  ): Promise<TrustedSubHostRecord> {
    return this.lock(async () => {
      const main = structuredClone(this.current());
      const machineIndex = main.machines.findIndex((item) => item.id === machineId);
      if (machineIndex < 0) throw new Error("This SubHost is no longer joined");
      const candidate = this.trustedRecord(main.machines[machineIndex] as TrustedSubHostIndexRecord);
      const usedMainInstanceIds = new Set([...this.routeValues.values()].flatMap((routes) => routes.routes.map((route) => route.mainInstanceId)));
      update(candidate, { usedMainInstanceIds });
      const parsed = parseTrustedMachine(candidate);
      if (parsed.id !== machineId) throw new Error("A SubHost machine ID cannot be changed");
      const routeFile = parseMachineRouteFile({ schemaVersion: 1, machineId, routes: parsed.routes, retiredRoutes: parsed.retiredRoutes }, machineId);
      assertMainRouteIdsAvailable(this.routeValues, machineId, routeFile.routes);
      main.machines[machineIndex] = {
        id: parsed.id,
        name: parsed.name,
        certificatePem: parsed.certificatePem,
        fingerprint: parsed.fingerprint,
        joinedAt: parsed.joinedAt,
      };
      main.revision += 1;
      const parsedMain = parseMainFile(main);
      await writeJson(this.routePath(machineId), routeFile);
      await writeJson(this.path, parsedMain);
      this.routeValues.set(machineId, routeFile);
      this.value = parsedMain;
      return structuredClone(parsed);
    });
  }

  private current(): MainMachineFile { if (!this.value) throw new Error("Machine state is not initialized"); return this.value; }
  private routePath(machineId: string): string { return join(this.root, `${checkedId(machineId, "machine ID")}.routes.json`); }
  private trustedRecord(index: TrustedSubHostIndexRecord): TrustedSubHostRecord {
    const routes = this.routeValues.get(index.id) ?? { schemaVersion: 1 as const, machineId: index.id, routes: [], retiredRoutes: [] };
    return structuredClone({ ...index, routes: routes.routes, retiredRoutes: routes.retiredRoutes });
  }
  private async lock<T>(work: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const previous = this.tail;
    this.tail = new Promise<void>((resolveTail) => { release = resolveTail; });
    await previous;
    try { await this.initialize(); return await work(); } finally { release(); }
  }
  private mutateMain<T>(work: (value: MainMachineFile) => T): Promise<T> {
    return this.lock(async () => {
      const candidate = structuredClone(this.current());
      const result = work(candidate);
      candidate.revision += 1;
      this.value = parseMainFile(candidate);
      await this.persistMain();
      return result;
    });
  }
  private mutateRoute<T>(machineId: string, work: (value: MachineRouteFile) => T): Promise<T> {
    return this.lock(async () => {
      if (!this.current().machines.some((item) => item.id === machineId)) throw new Error("This SubHost is no longer joined");
      const current = this.routeValues.get(machineId) ?? { schemaVersion: 1 as const, machineId, routes: [], retiredRoutes: [] };
      const candidate = structuredClone(current);
      const result = work(candidate);
      const parsed = parseMachineRouteFile(candidate, machineId);
      assertMainRouteIdsAvailable(this.routeValues, machineId, parsed.routes);
      await writeJson(this.routePath(machineId), parsed);
      this.routeValues.set(machineId, parsed);
      const main = structuredClone(this.current());
      main.revision += 1;
      this.value = parseMainFile(main);
      await this.persistMain();
      return result;
    });
  }
  private async persistMain(): Promise<void> { await writeJson(this.path, this.current()); }
}

export class SubHostMachineState {
  readonly root: string;
  readonly path: string;
  constructor(root: string) { this.root = resolve(root); this.path = join(this.root, "subhost.json"); }

  async load(): Promise<SubHostUpstreamRecord | undefined> {
    await ensureDirectory(this.root);
    const stored = await readJson(this.path);
    return stored === undefined ? undefined : parseSubHostFile(stored);
  }

  async prepare(joinFile: MachineJoinFile, machineName: string): Promise<SubHostUpstreamRecord> {
    const parsed = parseJoinFile(joinFile);
    if (Date.parse(parsed.expiresAt) <= Date.now()) throw new Error("This SubHost join file has expired");
    const current = await this.load();
    if (current && current.mainFingerprint !== parsed.mainFingerprint) throw new Error("This SubHost is already assigned to another Main");
    if (current && current.joinToken === undefined) throw new Error("This SubHost is already enrolled; start it without a join file");
    const record: SubHostUpstreamRecord = current ?? {
      schemaVersion: 1,
      machineId: randomUUID(),
      machineName: checkedName(machineName),
      identity: await generateHostIdentity(),
      mainCertificatePem: parsed.mainCertificatePem,
      mainFingerprint: parsed.mainFingerprint,
      joinToken: parsed.token,
    };
    if (record.joinToken && record.joinToken !== parsed.token) throw new Error("This SubHost already has a pending join file");
    await writeJson(this.path, record);
    return structuredClone(record);
  }

  async markJoined(): Promise<SubHostUpstreamRecord> {
    const record = await this.load();
    if (!record) throw new Error("SubHost upstream state is missing");
    delete record.joinToken;
    await writeJson(this.path, record);
    return record;
  }
}

export async function readMachineJoinFile(path: string): Promise<MachineJoinFile> {
  return parseJoinFile(JSON.parse(await readFile(resolve(path), "utf8")) as unknown);
}

export async function writeMachineJoinFile(path: string, value: MachineJoinFile): Promise<void> {
  const target = resolve(path);
  await ensureJoinParent(dirname(target));
  await writeJson(target, parseJoinFile(value), false);
}

function parseMainFile(input: unknown): MainMachineFile {
  const value = object(input, "Main machine state");
  exact(value, ["schemaVersion", "revision", "mainId", "mainName", "identity", "pendingJoins", "machines"]);
  if (value.schemaVersion !== 1 || !Number.isSafeInteger(value.revision) || (value.revision as number) < 0) throw new Error("Main machine state version is invalid");
  if (!Array.isArray(value.pendingJoins) || !Array.isArray(value.machines)) throw new Error("Main machine state collections are invalid");
  return {
    schemaVersion: 1,
    revision: value.revision as number,
    mainId: checkedId(value.mainId, "Main machine ID"),
    mainName: checkedName(value.mainName),
    identity: parseHostTlsIdentity(value.identity),
    pendingJoins: value.pendingJoins.map((item) => {
      const record = object(item, "pending SubHost join"); exact(record, ["tokenHash", "expiresAt"]);
      const tokenHashValue = text(record.tokenHash, "join token hash"); if (!SAFE_FINGERPRINT.test(tokenHashValue)) throw new Error("Join token hash is invalid");
      return { tokenHash: tokenHashValue, expiresAt: timestamp(record.expiresAt, "join expiry") };
    }),
    machines: value.machines.map(parseMachineIndex),
  };
}

function parseMachineIndex(input: unknown): TrustedSubHostIndexRecord {
  const value = object(input, "SubHost trust record");
  exact(value, ["id", "name", "certificatePem", "fingerprint", "joinedAt"]);
  const certificatePem = pem(value.certificatePem, "SubHost certificate");
  const certificate = new X509Certificate(certificatePem);
  const fingerprint = text(value.fingerprint, "SubHost fingerprint");
  if (!SAFE_FINGERPRINT.test(fingerprint) || certificate.fingerprint256.replaceAll(":", "").toLowerCase() !== fingerprint) throw new Error("SubHost certificate fingerprint is invalid");
  return { id: checkedId(value.id, "machine ID"), name: checkedName(value.name), certificatePem: certificate.toString(), fingerprint, joinedAt: timestamp(value.joinedAt, "joinedAt") };
}

function parseTrustedMachine(input: unknown): TrustedSubHostRecord {
  const value = object(input, "SubHost record");
  exact(value, ["id", "name", "certificatePem", "fingerprint", "joinedAt", "routes", "retiredRoutes"]);
  const index = parseMachineIndex({ id: value.id, name: value.name, certificatePem: value.certificatePem, fingerprint: value.fingerprint, joinedAt: value.joinedAt });
  if (!Array.isArray(value.routes) || !Array.isArray(value.retiredRoutes)) throw new Error("SubHost routes are invalid");
  return { ...index, routes: value.routes.map(parseRoute), retiredRoutes: parseRetiredRoutes(value.retiredRoutes) };
}

function parseMachineRouteFile(input: unknown, expectedMachineId: string): MachineRouteFile {
  const value = object(input, "SubHost route state");
  exact(value, ["schemaVersion", "machineId", "routes", "retiredRoutes"]);
  if (value.schemaVersion !== 1 || value.machineId !== expectedMachineId) throw new Error("SubHost route state identity is invalid");
  if (!Array.isArray(value.routes) || !Array.isArray(value.retiredRoutes)) throw new Error("SubHost route state collections are invalid");
  const routes = value.routes.map(parseRoute);
  const nativeIds = routes.map((route) => route.nativeInstanceId);
  const mainIds = routes.map((route) => route.mainInstanceId);
  if (new Set(nativeIds).size !== nativeIds.length) throw new Error("Native instance route IDs are duplicated");
  if (new Set(mainIds).size !== mainIds.length) throw new Error("Main instance route IDs are duplicated");
  return { schemaVersion: 1, machineId: expectedMachineId, routes, retiredRoutes: parseRetiredRoutes(value.retiredRoutes) };
}

function parseRetiredRoutes(input: unknown[]): MachineRouteRetirement[] {
  const retiredRoutes = input.map((item) => {
    const value = object(item, "retired SubHost route");
    exact(value, ["nativeInstanceId", "runtimeGeneration"]);
    if (!Number.isSafeInteger(value.runtimeGeneration) || (value.runtimeGeneration as number) < 0) throw new Error("Retired route runtime generation is invalid");
    return { nativeInstanceId: text(value.nativeInstanceId, "retired native instance ID", 128), runtimeGeneration: value.runtimeGeneration as number };
  });
  const nativeIds = retiredRoutes.map((item) => item.nativeInstanceId);
  if (new Set(nativeIds).size !== nativeIds.length) throw new Error("Retired native instance IDs are duplicated");
  return retiredRoutes;
}

function assertGloballyUniqueMainRouteIds(routeValues: ReadonlyMap<string, MachineRouteFile>): void {
  const seen = new Set<string>();
  for (const routeFile of routeValues.values()) {
    for (const route of routeFile.routes) {
      if (seen.has(route.mainInstanceId)) throw new Error("Main instance route IDs are duplicated across SubHosts");
      seen.add(route.mainInstanceId);
    }
  }
}

function assertMainRouteIdsAvailable(
  routeValues: ReadonlyMap<string, MachineRouteFile>,
  machineId: string,
  routes: readonly MachineRouteRecord[],
): void {
  const usedByOtherMachines = new Set(
    [...routeValues.entries()]
      .filter(([candidateId]) => candidateId !== machineId)
      .flatMap(([, routeFile]) => routeFile.routes.map((route) => route.mainInstanceId)),
  );
  if (routes.some((route) => usedByOtherMachines.has(route.mainInstanceId))) throw new Error("Main instance route ID is already used by another SubHost");
}

function parseRoute(input: unknown): MachineRouteRecord {
  const value = object(input, "SubHost instance route"); exact(value, ["mainInstanceId", "nativeInstanceId", "snapshot"]);
  const mainInstanceId = checkedId(value.mainInstanceId, "Main instance ID");
  const nativeInstanceId = text(value.nativeInstanceId, "native instance ID", 128);
  const snapshot = parseInstanceSnapshot(value.snapshot);
  if (snapshot.id !== mainInstanceId) throw new Error("Stored SubHost snapshot does not use its Main instance identity");
  return { mainInstanceId, nativeInstanceId, snapshot };
}

function parseSubHostFile(input: unknown): SubHostUpstreamRecord {
  const value = object(input, "SubHost upstream state");
  exact(value, ["schemaVersion", "machineId", "machineName", "identity", "mainCertificatePem", "mainFingerprint", "joinToken"]);
  if (value.schemaVersion !== 1) throw new Error("SubHost upstream state version is invalid");
  const mainCertificatePem = pem(value.mainCertificatePem, "Main certificate");
  const certificate = new X509Certificate(mainCertificatePem);
  const mainFingerprint = text(value.mainFingerprint, "Main fingerprint");
  if (!SAFE_FINGERPRINT.test(mainFingerprint) || certificate.fingerprint256.replaceAll(":", "").toLowerCase() !== mainFingerprint) throw new Error("Main certificate fingerprint is invalid");
  const joinToken = value.joinToken === undefined ? undefined : text(value.joinToken, "join token");
  if (joinToken !== undefined && !SAFE_TOKEN.test(joinToken)) throw new Error("Join token is invalid");
  return { schemaVersion: 1, machineId: checkedId(value.machineId, "machine ID"), machineName: checkedName(value.machineName), identity: parseHostTlsIdentity(value.identity), mainCertificatePem: certificate.toString(), mainFingerprint, ...(joinToken === undefined ? {} : { joinToken }) };
}

function parseJoinFile(input: unknown): MachineJoinFile {
  const value = object(input, "SubHost join file"); exact(value, ["schemaVersion", "token", "mainCertificatePem", "mainFingerprint", "expiresAt"]);
  if (value.schemaVersion !== 1) throw new Error("SubHost join file version is invalid");
  const token = text(value.token, "join token"); if (!SAFE_TOKEN.test(token)) throw new Error("Join token is invalid");
  const mainCertificatePem = pem(value.mainCertificatePem, "Main certificate");
  const certificate = new X509Certificate(mainCertificatePem);
  const mainFingerprint = text(value.mainFingerprint, "Main fingerprint");
  if (!SAFE_FINGERPRINT.test(mainFingerprint) || certificate.fingerprint256.replaceAll(":", "").toLowerCase() !== mainFingerprint) throw new Error("Main certificate fingerprint is invalid");
  return { schemaVersion: 1, token, mainCertificatePem: certificate.toString(), mainFingerprint, expiresAt: timestamp(value.expiresAt, "join expiry") };
}

function tokenHash(token: string): string { if (!SAFE_TOKEN.test(token)) throw new Error("Join token is invalid"); return createHash("sha256").update(token).digest("hex"); }
function checkedId(value: unknown, field: string): string { const result = text(value, field); if (!SAFE_ID.test(result)) throw new Error(`${field} is invalid`); return result; }
function checkedName(value: unknown): string { return text(value, "machine name", 256); }
function timestamp(value: unknown, field: string): string { const result = text(value, field, 64); if (new Date(result).toISOString() !== result) throw new Error(`${field} is invalid`); return result; }
function text(value: unknown, field: string, max = 4_096): string { if (typeof value !== "string" || value.length < 1 || value.length > max || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) throw new Error(`${field} is invalid`); return value; }
function pem(value: unknown, field: string): string { if (typeof value !== "string" || value.length < 1 || value.length > 64_000 || /[\u0000\u007f-\u009f]/u.test(value)) throw new Error(`${field} is invalid`); return value; }
function object(value: unknown, field: string): Record<string, unknown> { if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${field} must be an object`); return value as Record<string, unknown>; }
function exact(value: Record<string, unknown>, allowed: readonly string[]): void { const set = new Set(allowed); const unknown = Object.keys(value).filter((key) => !set.has(key)); if (unknown.length) throw new Error(`State contains unknown fields: ${unknown.join(", ")}`); }

async function ensureDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Machine state path is not a private directory: ${path}`);
  if (process.platform === "win32") await hardenWindowsPrivatePath(path, true);
  else if ((info.mode & 0o777) !== 0o700) await chmod(path, 0o700);
}

async function ensureJoinParent(path: string): Promise<void> {
  try {
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Join-file parent is not a directory: ${path}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await mkdir(path, { recursive: true, mode: 0o700 });
  }
}

async function readJson(path: string): Promise<unknown | undefined> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_DURABLE_CATALOG_BYTES) throw new Error(`Machine state file is invalid: ${path}`);
    await hardenWindowsPrivatePath(path, false);
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function writeJson(path: string, value: unknown, manageParent = true): Promise<void> {
  if (manageParent) await ensureDirectory(dirname(path));
  const bytes = `${JSON.stringify(value, null, 2)}\n`;
  if (Buffer.byteLength(bytes) > MAX_DURABLE_CATALOG_BYTES) throw new Error("Machine state exceeds its storage boundary");
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close(); handle = undefined;
    await rename(temporary, path);
    await hardenWindowsPrivatePath(path, false);
    await syncPrivateDirectory(dirname(path));
  } finally { await handle?.close().catch(() => {}); await rm(temporary, { force: true }).catch(() => {}); }
}
