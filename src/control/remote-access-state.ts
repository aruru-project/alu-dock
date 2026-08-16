import "reflect-metadata";

import { constants, type Stats } from "node:fs";
import { chmod, link, lstat, mkdir, open, readdir, realpath, rename, rm, unlink } from "node:fs/promises";
import { randomBytes, randomUUID, X509Certificate } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import {
  BasicConstraintsExtension,
  ExtendedKeyUsageExtension,
  KeyUsageFlags,
  KeyUsagesExtension,
  PemConverter,
  SubjectKeyIdentifierExtension,
  X509CertificateGenerator,
} from "@peculiar/x509";

const MAX_STATE_FILE_BYTES = 256 * 1024;
const ID_PATTERN = /^[0-9a-f-]{36}$/u;
const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/u;
export const PAIRING_WINDOW_MS = 5 * 60_000;

export interface RemoteAccessSettings {
  schemaVersion: 1;
  revision: number;
  enabled: boolean;
  port: number;
}

export interface RemoteAccessStatus {
  schemaVersion: 1;
  configRevision: number;
  state: "disabled" | "listening" | "error" | "stopped";
  activePort?: number;
  message?: string;
  updatedAt: string;
}

export interface HostTlsIdentity {
  certificatePem: string;
  privateKeyPem: string;
  fingerprint: string;
}

export interface PairingWindow {
  schemaVersion: 1;
  id: string;
  openedAt: string;
  expiresAt: string;
}

export interface PendingPairing {
  schemaVersion: 1;
  id: string;
  windowId: string;
  deviceName: string;
  fingerprint: string;
  requestedAt: string;
  expiresAt: string;
}

export interface TrustedClient {
  schemaVersion: 1;
  deviceName: string;
  fingerprint: string;
  certificatePem: string;
  pairedAt: string;
}

export function remoteAccessStateRoot(catalogPath: string): string {
  return join(dirname(resolve(catalogPath)), "remote-access");
}

export class RemoteAccessState {
  readonly root: string;
  private readonly pendingDirectory: string;
  private readonly approvalDirectory: string;
  private readonly trustedDirectory: string;

  constructor(root: string) {
    this.root = resolve(root);
    this.pendingDirectory = join(this.root, "pending");
    this.approvalDirectory = join(this.root, "approvals");
    this.trustedDirectory = join(this.root, "trusted");
  }

  async initialize(): Promise<void> {
    await ensurePrivateDirectory(this.root);
    await Promise.all([
      ensurePrivateDirectory(this.pendingDirectory),
      ensurePrivateDirectory(this.approvalDirectory),
      ensurePrivateDirectory(this.trustedDirectory),
    ]);
  }

  async clearVolatilePairings(): Promise<void> {
    await this.initialize();
    await Promise.all([
      clearRegularFiles(this.pendingDirectory),
      clearRegularFiles(this.approvalDirectory),
      unlink(join(this.root, "pairing-window.json")).catch(ignoreMissing),
      clearClosingPairingWindows(this.root),
    ]);
  }

  async openPairingWindow(): Promise<PairingWindow> {
    await this.initialize();
    const openedAt = new Date();
    const expiresAt = new Date(openedAt.getTime() + PAIRING_WINDOW_MS);
    const window = parsePairingWindow({
      schemaVersion: 1,
      id: randomUUID(),
      openedAt: openedAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
    });
    await writePrivateJson(join(this.root, "pairing-window.json"), window);
    await removePairingRecords(
      this.pendingDirectory,
      this.approvalDirectory,
      (record) => record.windowId !== window.id,
    );
    return window;
  }

  async readPairingWindow(): Promise<PairingWindow | undefined> {
    await this.initialize();
    const value = await readPrivateJsonIfPresent(join(this.root, "pairing-window.json"));
    return value === undefined ? undefined : parsePairingWindow(value);
  }

  async closePairingWindow(expectedId?: string): Promise<boolean> {
    if (expectedId !== undefined) assertPairingId(expectedId);
    await this.initialize();
    if (expectedId !== undefined) {
      const current = await this.readPairingWindow();
      if (!current || current.id !== expectedId) return false;
    }
    const claimed = await takePairingWindow(this.root, expectedId, "closing");
    if (!claimed) return false;
    await unlink(claimed.path).catch(ignoreMissing);
    await removePairingRecords(
      this.pendingDirectory,
      this.approvalDirectory,
      (record) => record.windowId === claimed.window.id,
    );
    return true;
  }

  /** Atomically linearizes final trust against a simultaneous local close. */
  async commitPairedClient(windowId: string, client: TrustedClient): Promise<boolean> {
    assertPairingId(windowId);
    await this.initialize();
    const claimed = await takePairingWindow(this.root, windowId, "committing");
    if (!claimed) return false;
    try {
      await this.trustClient(client);
      await removePairingRecords(
        this.pendingDirectory,
        this.approvalDirectory,
        (record) => record.windowId === claimed.window.id,
      );
      return true;
    } finally {
      await unlink(claimed.path).catch(ignoreMissing);
    }
  }

  async readSettings(): Promise<RemoteAccessSettings> {
    await this.initialize();
    const value = await readPrivateJsonIfPresent(join(this.root, "settings.json"));
    if (value === undefined) return { schemaVersion: 1, revision: 0, enabled: false, port: 9999 };
    return parseSettings(value);
  }

  /** Local Host TUI facade. This is deliberately not reachable through DockClient. */
  async writeSettings(input: { enabled: boolean; port: number }): Promise<RemoteAccessSettings> {
    const current = await this.readSettings();
    const next = parseSettings({ schemaVersion: 1, revision: current.revision + 1, ...input });
    await writePrivateJson(join(this.root, "settings.json"), next);
    return next;
  }

  async readStatus(): Promise<RemoteAccessStatus | undefined> {
    await this.initialize();
    const value = await readPrivateJsonIfPresent(join(this.root, "status.json"));
    return value === undefined ? undefined : parseStatus(value);
  }

  async writeStatus(status: RemoteAccessStatus): Promise<void> {
    await this.initialize();
    await writePrivateJson(join(this.root, "status.json"), parseStatus(status));
  }

  async ensureHostIdentity(): Promise<HostTlsIdentity> {
    await this.initialize();
    const path = join(this.root, "identity.json");
    const existing = await readPrivateJsonIfPresent(path);
    if (existing !== undefined) return parseIdentity(existing);
    const generated = await generateHostIdentity();
    // The Unix Host is already the single process owner when this is called.
    // Atomic rename prevents a crash from leaving a partial long-lived key.
    await writePrivateJson(path, generated);
    return generated;
  }

  async publishPending(pairing: PendingPairing): Promise<void> {
    await this.initialize();
    assertPairingId(pairing.id);
    await writePrivateJson(join(this.pendingDirectory, `${pairing.id}.json`), parsePending(pairing), true);
  }

  async removePending(id: string): Promise<void> {
    assertPairingId(id);
    await Promise.all([
      unlink(join(this.pendingDirectory, `${id}.json`)).catch(ignoreMissing),
      unlink(join(this.approvalDirectory, `${id}.json`)).catch(ignoreMissing),
    ]);
  }

  async listPending(): Promise<PendingPairing[]> {
    await this.initialize();
    return readRecords(this.pendingDirectory, parsePending, ID_PATTERN);
  }

  /** Local Host TUI facade. The PIN is written mode 0600 and consumed by Host. */
  async approvePairing(id: string, pin: string): Promise<void> {
    assertPairingId(id);
    if (!/^\d{4}$/u.test(pin)) throw new Error("PIN must contain exactly four digits");
    const pending = await readPrivateJsonIfPresent(join(this.pendingDirectory, `${id}.json`));
    if (pending === undefined) throw new Error("This pairing request is no longer waiting");
    parsePending(pending);
    await writePrivateJson(join(this.approvalDirectory, `${id}.json`), { schemaVersion: 1, pin }, true);
  }

  async consumeApproval(id: string): Promise<string | undefined> {
    assertPairingId(id);
    const path = join(this.approvalDirectory, `${id}.json`);
    const value = await readPrivateJsonIfPresent(path);
    if (value === undefined) return undefined;
    await unlink(path).catch(ignoreMissing);
    const record = object(value, "approval");
    exact(record, ["schemaVersion", "pin"], "approval");
    if (record.schemaVersion !== 1 || typeof record.pin !== "string" || !/^\d{4}$/u.test(record.pin)) throw new Error("Pairing approval is invalid");
    return record.pin;
  }

  async trustClient(client: TrustedClient): Promise<void> {
    await this.initialize();
    const parsed = parseTrusted(client);
    await writePrivateJson(join(this.trustedDirectory, `${parsed.fingerprint}.json`), parsed);
  }

  async trustedClient(fingerprint: string): Promise<TrustedClient | undefined> {
    assertFingerprint(fingerprint);
    await this.initialize();
    const value = await readPrivateJsonIfPresent(join(this.trustedDirectory, `${fingerprint}.json`));
    if (value === undefined) return undefined;
    const trusted = parseTrusted(value);
    return trusted.fingerprint === fingerprint ? trusted : undefined;
  }

  async listTrusted(): Promise<TrustedClient[]> {
    await this.initialize();
    return readRecords(this.trustedDirectory, parseTrusted, FINGERPRINT_PATTERN);
  }

  /** Local Host TUI facade. */
  async revokeClient(fingerprint: string): Promise<boolean> {
    assertFingerprint(fingerprint);
    await this.initialize();
    try {
      await unlink(join(this.trustedDirectory, `${fingerprint}.json`));
      await syncDirectory(this.trustedDirectory);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }
}

async function generateHostIdentity(): Promise<HostTlsIdentity> {
  const algorithm: RsaHashedKeyGenParams = {
    name: "RSASSA-PKCS1-v1_5",
    hash: "SHA-256",
    modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]),
  };
  const keys = await globalThis.crypto.subtle.generateKey(algorithm, true, ["sign", "verify"]);
  const notBefore = new Date(Date.now() - 5 * 60_000);
  const notAfter = new Date(notBefore);
  notAfter.setUTCFullYear(notAfter.getUTCFullYear() + 20);
  const certificate = await X509CertificateGenerator.createSelfSigned({
    serialNumber: randomBytes(16).toString("hex"),
    name: "CN=Alu Dock Host",
    notBefore,
    notAfter,
    signingAlgorithm: algorithm,
    keys,
    extensions: [
      new BasicConstraintsExtension(false, undefined, true),
      new KeyUsagesExtension(KeyUsageFlags.digitalSignature | KeyUsageFlags.keyEncipherment, true),
      new ExtendedKeyUsageExtension(["1.3.6.1.5.5.7.3.1"], true),
      await SubjectKeyIdentifierExtension.create(keys.publicKey),
    ],
  });
  const privateKey = await globalThis.crypto.subtle.exportKey("pkcs8", keys.privateKey);
  const certificatePem = certificate.toString("pem");
  return {
    certificatePem,
    privateKeyPem: PemConverter.encode(privateKey, "PRIVATE KEY"),
    fingerprint: certificateFingerprint(new X509Certificate(certificatePem).raw),
  };
}

export function certificateFingerprint(raw: Buffer): string {
  return new X509Certificate(raw).fingerprint256.replaceAll(":", "").toLowerCase();
}

function parseSettings(input: unknown): RemoteAccessSettings {
  const value = object(input, "remote access settings");
  exact(value, ["schemaVersion", "revision", "enabled", "port"], "remote access settings");
  if (value.schemaVersion !== 1 || !Number.isSafeInteger(value.revision) || (value.revision as number) < 0) throw new Error("Remote access settings version or revision is invalid");
  if (typeof value.enabled !== "boolean") throw new Error("Remote access enabled must be true or false");
  if (!Number.isSafeInteger(value.port) || (value.port as number) < 1 || (value.port as number) > 65535) throw new Error("Remote access port must be between 1 and 65535");
  return { schemaVersion: 1, revision: value.revision as number, enabled: value.enabled, port: value.port as number };
}

function parseStatus(input: unknown): RemoteAccessStatus {
  const value = object(input, "remote access status");
  exact(value, ["schemaVersion", "configRevision", "state", "activePort", "message", "updatedAt"], "remote access status");
  if (value.schemaVersion !== 1 || !Number.isSafeInteger(value.configRevision) || (value.configRevision as number) < 0) throw new Error("Remote access status version or revision is invalid");
  if (!["disabled", "listening", "error", "stopped"].includes(String(value.state))) throw new Error("Remote access status state is invalid");
  if (value.activePort !== undefined && (!Number.isSafeInteger(value.activePort) || (value.activePort as number) < 1 || (value.activePort as number) > 65535)) throw new Error("Remote access status port is invalid");
  if (value.message !== undefined && (typeof value.message !== "string" || value.message.length > 2048)) throw new Error("Remote access status message is invalid");
  if (typeof value.updatedAt !== "string" || !Number.isFinite(Date.parse(value.updatedAt))) throw new Error("Remote access status time is invalid");
  return value as unknown as RemoteAccessStatus;
}

function parseIdentity(input: unknown): HostTlsIdentity {
  const value = object(input, "Host TLS identity");
  exact(value, ["certificatePem", "privateKeyPem", "fingerprint"], "Host TLS identity");
  if (typeof value.certificatePem !== "string" || typeof value.privateKeyPem !== "string" || typeof value.fingerprint !== "string") throw new Error("Host TLS identity is invalid");
  const certificate = new X509Certificate(value.certificatePem);
  const fingerprint = certificateFingerprint(certificate.raw);
  if (fingerprint !== value.fingerprint) throw new Error("Host TLS identity fingerprint does not match its certificate");
  assertFingerprint(fingerprint);
  return { certificatePem: value.certificatePem, privateKeyPem: value.privateKeyPem, fingerprint };
}

function parsePairingWindow(input: unknown): PairingWindow {
  const value = object(input, "pairing window");
  exact(value, ["schemaVersion", "id", "openedAt", "expiresAt"], "pairing window");
  if (value.schemaVersion !== 1 || typeof value.id !== "string" || typeof value.openedAt !== "string" || typeof value.expiresAt !== "string") throw new Error("Pairing window is invalid");
  assertPairingId(value.id);
  const openedAt = Date.parse(value.openedAt);
  const expiresAt = Date.parse(value.expiresAt);
  if (!Number.isFinite(openedAt) || !Number.isFinite(expiresAt) || expiresAt <= openedAt || expiresAt - openedAt > PAIRING_WINDOW_MS) throw new Error("Pairing window time is invalid");
  return value as unknown as PairingWindow;
}

function parsePending(input: unknown): PendingPairing {
  const value = object(input, "pending pairing");
  exact(value, ["schemaVersion", "id", "windowId", "deviceName", "fingerprint", "requestedAt", "expiresAt"], "pending pairing");
  if (value.schemaVersion !== 1 || typeof value.id !== "string" || typeof value.windowId !== "string" || typeof value.deviceName !== "string" || typeof value.fingerprint !== "string" || typeof value.requestedAt !== "string" || typeof value.expiresAt !== "string") throw new Error("Pending pairing is invalid");
  assertPairingId(value.id); assertPairingId(value.windowId); assertFingerprint(value.fingerprint); assertDeviceName(value.deviceName);
  const requestedAt = Date.parse(value.requestedAt);
  const expiresAt = Date.parse(value.expiresAt);
  if (!Number.isFinite(requestedAt) || !Number.isFinite(expiresAt) || expiresAt <= requestedAt || expiresAt - requestedAt > PAIRING_WINDOW_MS) throw new Error("Pending pairing time is invalid");
  return value as unknown as PendingPairing;
}

function parseTrusted(input: unknown): TrustedClient {
  const value = object(input, "trusted client");
  exact(value, ["schemaVersion", "deviceName", "fingerprint", "certificatePem", "pairedAt"], "trusted client");
  if (value.schemaVersion !== 1 || typeof value.deviceName !== "string" || typeof value.fingerprint !== "string" || typeof value.certificatePem !== "string" || typeof value.pairedAt !== "string") throw new Error("Trusted client is invalid");
  assertDeviceName(value.deviceName); assertFingerprint(value.fingerprint);
  const fingerprint = certificateFingerprint(new X509Certificate(value.certificatePem).raw);
  if (fingerprint !== value.fingerprint) throw new Error("Trusted client fingerprint does not match its certificate");
  if (!Number.isFinite(Date.parse(value.pairedAt))) throw new Error("Trusted client time is invalid");
  return value as unknown as TrustedClient;
}

function assertDeviceName(value: string): void {
  if (value.length < 1 || value.length > 128 || /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069\ufeff]/u.test(value)) throw new Error("Device name must be a safe non-empty name");
}
function assertPairingId(value: string): void { if (!ID_PATTERN.test(value)) throw new Error("Pairing ID is invalid"); }
function assertFingerprint(value: string): void { if (!FINGERPRINT_PATTERN.test(value)) throw new Error("Certificate fingerprint is invalid"); }

async function readRecords<T>(directory: string, parse: (input: unknown) => T, names: RegExp): Promise<T[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const records: T[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json") || !names.test(entry.name.slice(0, -5))) continue;
    records.push(parse(await readPrivateJson(join(directory, entry.name))));
  }
  return records;
}

async function clearRegularFiles(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".json")) await unlink(join(directory, entry.name));
  }
}

async function clearClosingPairingWindows(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isFile() && /^\.[0-9a-f-]{36}\.(?:closing|committing)$/u.test(entry.name)) await unlink(join(directory, entry.name));
  }
}

async function removePairingRecords(
  pendingDirectory: string,
  approvalDirectory: string,
  shouldRemove: (record: PendingPairing) => boolean,
): Promise<void> {
  for (const entry of await readdir(pendingDirectory, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json") || !ID_PATTERN.test(entry.name.slice(0, -5))) continue;
    const id = entry.name.slice(0, -5);
    let record: PendingPairing;
    try { record = parsePending(await readPrivateJson(join(pendingDirectory, entry.name))); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (!shouldRemove(record)) continue;
    await Promise.all([
      unlink(join(pendingDirectory, entry.name)).catch(ignoreMissing),
      unlink(join(approvalDirectory, `${id}.json`)).catch(ignoreMissing),
    ]);
  }
}

async function takePairingWindow(
  root: string,
  expectedId: string | undefined,
  suffix: "closing" | "committing",
): Promise<{ window: PairingWindow; path: string } | undefined> {
  const path = join(root, "pairing-window.json");
  const claimed = join(root, `.${randomUUID()}.${suffix}`);
  try {
    await rename(path, claimed);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }

  let window: PairingWindow;
  try {
    window = parsePairingWindow(await readPrivateJson(claimed));
  } catch (error) {
    await restorePairingWindow(claimed, path);
    throw error;
  }
  if (expectedId !== undefined && window.id !== expectedId) {
    await restorePairingWindow(claimed, path);
    return undefined;
  }
  return { window, path: claimed };
}

async function restorePairingWindow(closing: string, path: string): Promise<void> {
  let restoredOrSuperseded = false;
  try {
    await link(closing, path);
    restoredOrSuperseded = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    restoredOrSuperseded = true;
  } finally {
    if (restoredOrSuperseded) await unlink(closing).catch(ignoreMissing);
  }
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Remote access state path is not a real directory: ${path}`);
  if (await realpath(path) !== resolve(path)) throw new Error(`Remote access state path traverses a symbolic link: ${path}`);
  assertOwned(path, info);
  if ((info.mode & 0o777) !== 0o700) throw new Error(`Remote access state directory must have mode 0700: ${path}`);
}

async function readPrivateJsonIfPresent(path: string): Promise<unknown | undefined> {
  try { return await readPrivateJson(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}

async function readPrivateJson(path: string): Promise<unknown> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    assertPrivateFile(path, info);
    if (info.size > MAX_STATE_FILE_BYTES) throw new Error(`Remote access state file is too large: ${path}`);
    return JSON.parse((await handle.readFile()).toString("utf8")) as unknown;
  } finally { await handle.close(); }
}

async function syncDirectory(path: string): Promise<void> {
  const directory = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await directory.sync(); } finally { await directory.close(); }
}

async function writePrivateJson(path: string, value: unknown, exclusive = false): Promise<void> {
  await ensurePrivateDirectory(dirname(path));
  const bytes = `${JSON.stringify(value, null, 2)}\n`;
  if (Buffer.byteLength(bytes) > MAX_STATE_FILE_BYTES) throw new Error("Remote access state exceeds its storage limit");
  if (exclusive) {
    const handle = await open(path, "wx", 0o600);
    try { await handle.writeFile(bytes); await handle.sync(); await chmod(path, 0o600); }
    finally { await handle.close(); }
    return;
  }
  const temporary = join(dirname(path), `.${randomUUID()}.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(bytes); await handle.sync(); await handle.close(); handle = undefined;
    await chmod(temporary, 0o600);
    await rename(temporary, path);
    await syncDirectory(dirname(path));
  } finally { await handle?.close().catch(() => {}); await rm(temporary, { force: true }).catch(() => {}); }
}

function assertPrivateFile(path: string, info: Stats): void {
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Remote access state must be a regular non-symlink file: ${path}`);
  assertOwned(path, info);
  if ((info.mode & 0o777) !== 0o600) throw new Error(`Remote access state file must have mode 0600: ${path}`);
}
function assertOwned(path: string, info: Stats): void {
  if (typeof process.getuid !== "function" || info.uid !== process.getuid()) throw new Error(`Remote access state is not owned by the current user: ${path}`);
}
function ignoreMissing(error: unknown): void { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
function object(value: unknown, field: string): Record<string, unknown> { if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${field} must be an object`); return value as Record<string, unknown>; }
function exact(value: Record<string, unknown>, allowed: readonly string[], field: string): void { const known = new Set(allowed); const unknown = Object.keys(value).filter((key) => !known.has(key)); if (unknown.length) throw new Error(`${field} contains unknown fields: ${unknown.join(", ")}`); }
