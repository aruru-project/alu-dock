import {
  constants as cryptoConstants,
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  hkdfSync,
  randomBytes,
  sign,
  verify,
  X509Certificate,
} from "node:crypto";

import { SRP, SrpClient, SrpServer } from "fast-srp-hap";

export const MAX_PAIRING_LINE_BYTES = 16 * 1024;
export const PAIRING_SRP_PUBLIC_KEY_BYTES = 384;
export const PAIRING_SRP_PROOF_BYTES = 64;

const PAIRING_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const PAIRING_LABEL = Buffer.from("alu-dock-pair-setup-v1", "utf8");
const PAIRING_SRP_IDENTITY = Buffer.from("Pair-Setup", "utf8");
const PAIRING_ENCRYPT_SALT = Buffer.from("Alu-Dock-Pair-Setup-Encrypt-Salt-v1", "utf8");
const PAIRING_ENCRYPT_INFO = Buffer.from("Alu-Dock-Pair-Setup-Encrypt-Info-v1", "utf8");
const PAIRING_SIGN_SALT = Buffer.from("Alu-Dock-Pair-Setup-Sign-Salt-v1", "utf8");
const MAX_IDENTITY_CIPHERTEXT_BYTES = 1024;

export interface PairingBeginRecord {
  type: "pairing.begin.v1";
  deviceName: string;
  clientNonce: string;
}

export interface PairingPollRecord {
  type: "pairing.poll.v1";
  pairingId: string;
}

export interface PairingSrpProofRecord {
  type: "pairing.srp-proof.v1";
  pairingId: string;
  clientPublicKey: string;
  proof: string;
}

export interface PairingClientIdentityRecord {
  type: "pairing.client-identity.v1";
  pairingId: string;
  encrypted: string;
  authTag: string;
}

export interface PairingPendingRecord {
  type: "pairing.pending.v1";
  pairingId: string;
  retryAfterMs: number;
}

export interface PairingSrpChallengeRecord {
  type: "pairing.srp-challenge.v1";
  pairingId: string;
  salt: string;
  serverPublicKey: string;
}

export interface PairingSrpConfirmedRecord {
  type: "pairing.srp-confirmed.v1";
  pairingId: string;
  proof: string;
}

export interface PairingServerIdentityRecord {
  type: "pairing.server-identity.v1";
  pairingId: string;
  encrypted: string;
  authTag: string;
}

export interface PairingErrorRecord {
  type: "pairing.error.v1";
  code: "pairing_closed" | "busy" | "invalid_request" | "not_found" | "wrong_pin" | "expired" | "internal_error";
  message: string;
  retryAfterMs?: number;
}

export type PairingClientRecord = PairingBeginRecord | PairingPollRecord | PairingSrpProofRecord | PairingClientIdentityRecord;
export type PairingServerRecord = PairingPendingRecord | PairingSrpChallengeRecord | PairingSrpConfirmedRecord | PairingServerIdentityRecord | PairingErrorRecord;

export type ParsedPairingClientRecord =
  | { type: "pairing.begin.v1"; deviceName: string; clientNonce: Buffer }
  | { type: "pairing.poll.v1"; pairingId: string }
  | { type: "pairing.srp-proof.v1"; pairingId: string; clientPublicKey: Buffer; proof: Buffer }
  | { type: "pairing.client-identity.v1"; pairingId: string; encrypted: Buffer; authTag: Buffer };

export interface PairingSrpServerState {
  server: SrpServer;
  salt: Buffer;
  serverPublicKey: Buffer;
}

export interface PairingSrpClientState {
  client: SrpClient;
  clientPublicKey: Buffer;
  proof: Buffer;
}

export interface PairingIdentityContext {
  pairingId: string;
  clientNonce: Buffer;
  clientCertificate: Buffer;
  serverCertificate: Buffer;
}

export interface EncryptedPairingIdentity {
  encrypted: Buffer;
  authTag: Buffer;
}

/**
 * The wire lifecycle follows the proven HomeKit Pair Setup shape: SRP-6a
 * confirmation first, then AEAD-protected signatures binding both durable
 * identities. Transport requests may reconnect between every phase.
 */
export function parsePairingClientRecord(input: unknown): ParsedPairingClientRecord {
  const value = object(input, "pairing request");
  switch (value.type) {
    case "pairing.begin.v1": {
      exact(value, ["type", "deviceName", "clientNonce"], "pairing request");
      if (typeof value.deviceName !== "string") throw new Error("Pairing device name is invalid");
      assertDeviceName(value.deviceName);
      return {
        type: value.type,
        deviceName: value.deviceName,
        clientNonce: base64Bytes(value.clientNonce, "client nonce", 16),
      };
    }
    case "pairing.poll.v1":
      exact(value, ["type", "pairingId"], "pairing request");
      return { type: value.type, pairingId: pairingId(value.pairingId) };
    case "pairing.srp-proof.v1":
      exact(value, ["type", "pairingId", "clientPublicKey", "proof"], "pairing request");
      return {
        type: value.type,
        pairingId: pairingId(value.pairingId),
        clientPublicKey: base64Bytes(value.clientPublicKey, "SRP client public key", PAIRING_SRP_PUBLIC_KEY_BYTES),
        proof: base64Bytes(value.proof, "SRP client proof", PAIRING_SRP_PROOF_BYTES),
      };
    case "pairing.client-identity.v1":
      exact(value, ["type", "pairingId", "encrypted", "authTag"], "pairing request");
      return {
        type: value.type,
        pairingId: pairingId(value.pairingId),
        encrypted: base64BytesInRange(value.encrypted, "encrypted client identity", 1, MAX_IDENTITY_CIPHERTEXT_BYTES),
        authTag: base64Bytes(value.authTag, "client identity authentication tag", 16),
      };
    default:
      throw new Error("This connection needs pairing before it can use Alu Dock");
  }
}

export function createPairingSrpServer(pin: string): PairingSrpServerState {
  assertPin(pin);
  const salt = randomBytes(16);
  const secret = randomBytes(32);
  try {
    const server = new SrpServer(SRP.params.hap, salt, PAIRING_SRP_IDENTITY, Buffer.from(pin, "ascii"), secret);
    return { server, salt, serverPublicKey: Buffer.from(server.computeB()) };
  } finally {
    secret.fill(0);
  }
}

export function completePairingSrpServer(
  state: PairingSrpServerState,
  clientPublicKey: Buffer,
  clientProof: Buffer,
): { sessionKey: Buffer; serverProof: Buffer } {
  if (clientPublicKey.length !== PAIRING_SRP_PUBLIC_KEY_BYTES || clientProof.length !== PAIRING_SRP_PROOF_BYTES) {
    throw new Error("SRP proof has an invalid length");
  }
  state.server.setA(clientPublicKey);
  state.server.checkM1(clientProof);
  return {
    sessionKey: Buffer.from(state.server.computeK()),
    serverProof: Buffer.from(state.server.computeM2()),
  };
}

export function createPairingSrpClient(
  pin: string,
  salt: Buffer,
  serverPublicKey: Buffer,
): PairingSrpClientState {
  assertPin(pin);
  if (salt.length !== 16 || serverPublicKey.length !== PAIRING_SRP_PUBLIC_KEY_BYTES) throw new Error("SRP challenge is invalid");
  const secret = randomBytes(32);
  try {
    const client = new SrpClient(SRP.params.hap, salt, PAIRING_SRP_IDENTITY, Buffer.from(pin, "ascii"), secret, true);
    client.setB(serverPublicKey);
    return {
      client,
      clientPublicKey: Buffer.from(client.computeA()),
      proof: Buffer.from(client.computeM1()),
    };
  } finally {
    secret.fill(0);
  }
}

export function confirmPairingSrpClient(state: PairingSrpClientState, serverProof: Buffer): Buffer {
  if (serverProof.length !== PAIRING_SRP_PROOF_BYTES) throw new Error("SRP server proof is invalid");
  state.client.checkM2(serverProof);
  return Buffer.from(state.client.computeK());
}

export function createPairingIdentity(
  role: "client" | "server",
  sessionKey: Buffer,
  context: PairingIdentityContext,
  privateKeyPem: string,
): EncryptedPairingIdentity {
  validateIdentityInputs(sessionKey, context);
  const transcript = pairingIdentityTranscript(role, sessionKey, context);
  const signature = sign("sha256", transcript, {
    key: createPrivateKey(privateKeyPem),
    padding: cryptoConstants.RSA_PKCS1_PSS_PADDING,
    saltLength: 32,
  });
  const encrypted = encryptIdentity(role, sessionKey, context, transcript, signature);
  signature.fill(0);
  return encrypted;
}

export function verifyPairingIdentity(
  role: "client" | "server",
  sessionKey: Buffer,
  context: PairingIdentityContext,
  record: EncryptedPairingIdentity,
): boolean {
  validateIdentityInputs(sessionKey, context);
  if (record.encrypted.length < 1 || record.encrypted.length > MAX_IDENTITY_CIPHERTEXT_BYTES || record.authTag.length !== 16) return false;
  const transcript = pairingIdentityTranscript(role, sessionKey, context);
  let signature: Buffer;
  try {
    signature = decryptIdentity(role, sessionKey, context, transcript, record);
  } catch {
    return false;
  }
  const certificate = new X509Certificate(role === "client" ? context.clientCertificate : context.serverCertificate);
  assertPairingCertificate(certificate);
  try {
    return verify("sha256", transcript, {
      key: certificate.publicKey,
      padding: cryptoConstants.RSA_PKCS1_PSS_PADDING,
      saltLength: 32,
    }, signature);
  } finally {
    signature.fill(0);
  }
}

export function assertPairingCertificate(certificate: X509Certificate): void {
  const key = certificate.publicKey;
  if (key.asymmetricKeyType !== "rsa") throw new Error("Pairing certificates must use RSA keys");
  const modulusLength = key.asymmetricKeyDetails?.modulusLength;
  if (typeof modulusLength !== "number" || modulusLength < 2048) throw new Error("Pairing certificates must use RSA keys of at least 2048 bits");
}

export function base64(value: Buffer): string {
  return value.toString("base64");
}

export function pairingRequestDigest(record: { clientPublicKey: Buffer; proof: Buffer }): Buffer {
  return createHash("sha256").update(record.clientPublicKey).update(record.proof).digest();
}

function pairingIdentityTranscript(
  role: "client" | "server",
  sessionKey: Buffer,
  context: PairingIdentityContext,
): Buffer {
  const signContext = Buffer.from(hkdfSync(
    "sha512",
    sessionKey,
    PAIRING_SIGN_SALT,
    Buffer.from(`Alu-Dock-Pair-Setup-${role}-Sign-Info-v1`, "utf8"),
    32,
  ));
  const transcript = encodeFields([
    PAIRING_LABEL,
    Buffer.from(role, "ascii"),
    Buffer.from(context.pairingId, "ascii"),
    context.clientNonce,
    context.serverCertificate,
    context.clientCertificate,
    signContext,
  ]);
  signContext.fill(0);
  return transcript;
}

function encryptIdentity(
  role: "client" | "server",
  sessionKey: Buffer,
  context: PairingIdentityContext,
  transcript: Buffer,
  signature: Buffer,
): EncryptedPairingIdentity {
  const key = pairingEncryptionKey(sessionKey);
  const nonce = pairingNonce(role);
  const aad = pairingAad(role, context, transcript);
  try {
    const cipher = createCipheriv("chacha20-poly1305", key, nonce, { authTagLength: 16 });
    cipher.setAAD(aad, { plaintextLength: signature.length });
    return { encrypted: Buffer.concat([cipher.update(signature), cipher.final()]), authTag: cipher.getAuthTag() };
  } finally {
    key.fill(0);
  }
}

function decryptIdentity(
  role: "client" | "server",
  sessionKey: Buffer,
  context: PairingIdentityContext,
  transcript: Buffer,
  record: EncryptedPairingIdentity,
): Buffer {
  const key = pairingEncryptionKey(sessionKey);
  const nonce = pairingNonce(role);
  const aad = pairingAad(role, context, transcript);
  try {
    const decipher = createDecipheriv("chacha20-poly1305", key, nonce, { authTagLength: 16 });
    decipher.setAAD(aad, { plaintextLength: record.encrypted.length });
    decipher.setAuthTag(record.authTag);
    return Buffer.concat([decipher.update(record.encrypted), decipher.final()]);
  } finally {
    key.fill(0);
  }
}

function pairingEncryptionKey(sessionKey: Buffer): Buffer {
  return Buffer.from(hkdfSync("sha512", sessionKey, PAIRING_ENCRYPT_SALT, PAIRING_ENCRYPT_INFO, 32));
}

function pairingNonce(role: "client" | "server"): Buffer {
  return createHash("sha256").update(PAIRING_LABEL).update(Buffer.from(`:${role}:identity`, "ascii")).digest().subarray(0, 12);
}

function pairingAad(role: "client" | "server", context: PairingIdentityContext, transcript: Buffer): Buffer {
  return encodeFields([
    PAIRING_LABEL,
    Buffer.from(`${role}:identity`, "ascii"),
    Buffer.from(context.pairingId, "ascii"),
    createHash("sha256").update(transcript).digest(),
  ]);
}

function validateIdentityInputs(sessionKey: Buffer, context: PairingIdentityContext): void {
  if (sessionKey.length !== 64) throw new Error("Pairing session key is invalid");
  pairingId(context.pairingId);
  if (context.clientNonce.length !== 16) throw new Error("Pairing client nonce is invalid");
  const client = new X509Certificate(context.clientCertificate);
  const server = new X509Certificate(context.serverCertificate);
  assertPairingCertificate(client);
  assertPairingCertificate(server);
}

function encodeFields(fields: readonly Buffer[]): Buffer {
  const chunks: Buffer[] = [];
  for (const field of fields) {
    const length = Buffer.allocUnsafe(4);
    length.writeUInt32BE(field.length);
    chunks.push(length, field);
  }
  return Buffer.concat(chunks);
}

function pairingId(value: unknown): string {
  if (typeof value !== "string" || !PAIRING_ID_PATTERN.test(value)) throw new Error("Pairing ID is invalid");
  return value;
}

function base64Bytes(value: unknown, field: string, length: number): Buffer {
  return base64BytesInRange(value, field, length, length);
}

function base64BytesInRange(value: unknown, field: string, minimum: number, maximum: number): Buffer {
  if (typeof value !== "string" || value.length > Math.ceil(maximum / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
    throw new Error(`${field} is invalid`);
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.length < minimum || bytes.length > maximum || bytes.toString("base64") !== value) throw new Error(`${field} has an invalid length`);
  return bytes;
}

function assertPin(pin: string): void {
  if (!/^\d{4}$/u.test(pin)) throw new Error("Pairing PIN must contain exactly four digits");
}

function assertDeviceName(value: string): void {
  if (value.length < 1 || value.length > 128 || /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069\ufeff]/u.test(value)) {
    throw new Error("Pairing device name is invalid");
  }
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${field} must be an object`);
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, allowed: readonly string[], field: string): void {
  const known = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !known.has(key));
  if (unknown.length) throw new Error(`${field} contains unknown fields: ${unknown.join(", ")}`);
}
