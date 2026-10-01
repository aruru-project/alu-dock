import { constants as cryptoConstants, randomUUID, timingSafeEqual, X509Certificate } from "node:crypto";
import type { Socket } from "node:net";
import { createServer, type Server as TlsServer, type TLSSocket } from "node:tls";

import { encodeJsonLine, JsonLineDecoder } from "./json-lines.js";
import {
  assertPairingCertificate,
  base64,
  completePairingSrpServer,
  createPairingIdentity,
  createPairingSrpServer,
  MAX_PAIRING_LINE_BYTES,
  pairingRequestDigest,
  parsePairingClientRecord,
  type PairingErrorRecord,
  type PairingServerRecord,
  type PairingSrpServerState,
  verifyPairingIdentity,
} from "./remote-pairing.js";
import {
  certificateFingerprint,
  type HostTlsIdentity,
  type PairingWindow,
  type RemoteAccessSettings,
  RemoteAccessState,
} from "./remote-access-state.js";

const POLL_INTERVAL_MS = 200;
const PAIRING_RETRY_AFTER_MS = 1_000;
const MAX_PENDING_PAIRINGS = 32;
const MAX_REMOTE_CONNECTIONS = 256;
const MAX_PAIRING_REQUEST_BURST = 64;
const PAIRING_REQUESTS_PER_SECOND = 16;
const MAX_PAIRING_REQUEST_BURST_PER_SOURCE = 8;
const PAIRING_REQUESTS_PER_SECOND_PER_SOURCE = 2;
const MAX_ACTIVE_PAIRING_REQUEST_BURST = 16;
const ACTIVE_PAIRING_REQUESTS_PER_SECOND = 8;
const MAX_PENDING_PAIRINGS_PER_SOURCE = 4;
const MAX_PAIRING_RATE_SOURCES = 256;
const TLS_HANDSHAKE_TIMEOUT_MS = 5_000;
const PAIRING_REQUEST_TIMEOUT_MS = 2_000;
const PAIRING_RESPONSE_CLOSE_MS = 1_000;
const PAIRING_CONNECTION_HARD_TIMEOUT_MS = 8_000;
const PAIRING_PROOF_TIMEOUT_MS = 60_000;

interface PairingSession {
  id: string;
  windowId: string;
  deviceName: string;
  fingerprint: string;
  sourceKey: string;
  certificatePem: string;
  certificateRaw: Buffer;
  clientNonce: Buffer;
  expiresAt: number;
  requestTokens: number;
  tokenUpdatedAt: number;
  timeout?: NodeJS.Timeout;
  phase: "waiting_for_approval" | "waiting_for_srp_proof" | "waiting_for_identity" | "committing";
  srp?: PairingSrpServerState;
  sessionKey?: Buffer;
  acceptedSrpDigest?: Buffer;
  serverSrpProof?: Buffer;
  closed: boolean;
}

export interface RemoteAccessServerOptions {
  state: RemoteAccessState;
  acceptProtocolSocket: (socket: TLSSocket) => void;
  pollIntervalMs?: number;
}

/** Optional TLS ingress. Unknown certificates can reach pairing only during a local window. */
export class RemoteAccessServer {
  private server: TlsServer | undefined;
  private activePort: number | undefined;
  private timer: NodeJS.Timeout | undefined;
  private pollPromise: Promise<void> | undefined;
  private stopped = true;
  private lastAttemptedRevision = -1;
  private appliedRevision = -1;
  private nextApplyAttemptAt = 0;
  private identity: HostTlsIdentity | undefined;
  private activeWindow: PairingWindow | undefined;
  private activePairingId: string | undefined;
  private pairingRequestTokens = MAX_PAIRING_REQUEST_BURST;
  private pairingTokenUpdatedAt = Date.now();
  private readonly pairingSourceTokens = new Map<string, { tokens: number; updatedAt: number; lastSeenAt: number }>();
  private readonly transportSockets = new Set<Socket>();
  private readonly allRemoteSockets = new Set<TLSSocket>();
  private readonly liveRemoteSockets = new Map<TLSSocket, string>();
  private readonly pending = new Map<string, PairingSession>();
  private readonly inFlightPairingRequests = new Set<Promise<void>>();
  private readonly pollIntervalMs: number;

  constructor(private readonly options: RemoteAccessServerOptions) {
    this.pollIntervalMs = Math.max(50, options.pollIntervalMs ?? POLL_INTERVAL_MS);
  }

  async start(): Promise<void> {
    if (!this.stopped) return;
    this.stopped = false;
    try {
      await this.options.state.initialize();
      // Pairing is a local, explicit ceremony and never survives Host restart.
      await this.options.state.clearVolatilePairings();
      await this.triggerPoll();
    } catch (error) {
      await this.recordError(0, humanError(error));
    }
    this.timer = setInterval(() => { void this.triggerPoll(); }, this.pollIntervalMs);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.pollPromise?.catch(() => {});
    for (const socket of this.transportSockets) socket.destroy();
    for (const socket of this.allRemoteSockets) socket.destroy();
    await this.clearPairingSessions();
    if (this.inFlightPairingRequests.size > 0) await Promise.allSettled([...this.inFlightPairingRequests]);
    this.activeWindow = undefined;
    this.activePairingId = undefined;
    this.liveRemoteSockets.clear();
    this.allRemoteSockets.clear();
    this.transportSockets.clear();
    const server = this.server;
    this.server = undefined;
    this.activePort = undefined;
    if (server) await closeServer(server);
    await this.options.state.clearVolatilePairings().catch(() => {});
    await this.options.state.writeStatus({
      schemaVersion: 1,
      configRevision: this.lastAttemptedRevision < 0 ? 0 : this.lastAttemptedRevision,
      state: "stopped",
      updatedAt: new Date().toISOString(),
    }).catch(() => {});
  }

  private triggerPoll(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.pollPromise) return this.pollPromise;
    const current = this.poll().finally(() => {
      if (this.pollPromise === current) this.pollPromise = undefined;
    });
    this.pollPromise = current;
    return current;
  }

  private async poll(): Promise<void> {
    try {
      const settings = await this.options.state.readSettings();
      if (settings.revision !== this.lastAttemptedRevision) this.nextApplyAttemptAt = 0;
      if (settings.revision !== this.appliedRevision && Date.now() >= this.nextApplyAttemptAt) {
        this.lastAttemptedRevision = settings.revision;
        try {
          await this.applySettings(settings);
          this.appliedRevision = settings.revision;
          this.nextApplyAttemptAt = 0;
        } catch (error) {
          this.nextApplyAttemptAt = Date.now() + 1_000;
          await this.recordError(settings.revision, settings.enabled
            ? `Could not listen on port ${settings.port}: ${humanError(error)}`
            : humanError(error));
        }
      }
      if (this.stopped) return;
      await this.syncPairingWindow(settings.enabled && this.server !== undefined);
      await this.consumeApprovals();
      await this.reapRevokedSockets();
    } catch (error) {
      if (!this.stopped) await this.recordError(this.lastAttemptedRevision < 0 ? 0 : this.lastAttemptedRevision, humanError(error));
    }
  }

  private async applySettings(settings: RemoteAccessSettings): Promise<void> {
    if (!settings.enabled) {
      const previous = this.server;
      this.server = undefined;
      this.activePort = undefined;
      for (const socket of this.transportSockets) socket.destroy();
      for (const socket of this.allRemoteSockets) socket.destroy();
      if (previous) await closeServer(previous);
      await this.closePairingWindow();
      await this.options.state.writeStatus({ schemaVersion: 1, configRevision: settings.revision, state: "disabled", updatedAt: new Date().toISOString() });
      return;
    }
    if (this.server && this.activePort === settings.port) {
      await this.options.state.writeStatus({ schemaVersion: 1, configRevision: settings.revision, state: "listening", activePort: settings.port, updatedAt: new Date().toISOString() });
      return;
    }

    const previous = this.server;
    if (previous) {
      this.server = undefined;
      this.activePort = undefined;
      for (const socket of this.transportSockets) socket.destroy();
      for (const socket of this.allRemoteSockets) socket.destroy();
      await closeServer(previous);
      await this.closePairingWindow();
    }

    this.identity ??= await this.options.state.ensureHostIdentity();
    const next = this.createTlsServer(this.identity);
    try {
      await listen(next, settings.port);
    } catch (error) {
      try { next.close(); } catch {}
      throw error;
    }
    if (this.stopped) {
      await closeServer(next);
      return;
    }
    this.server = next;
    this.activePort = settings.port;
    await this.options.state.writeStatus({ schemaVersion: 1, configRevision: settings.revision, state: "listening", activePort: settings.port, updatedAt: new Date().toISOString() });
  }

  private createTlsServer(identity: HostTlsIdentity): TlsServer {
    const server = createServer({
      key: identity.privateKeyPem,
      cert: identity.certificatePem,
      requestCert: true,
      rejectUnauthorized: false,
      minVersion: "TLSv1.2",
      handshakeTimeout: TLS_HANDSHAKE_TIMEOUT_MS,
      secureOptions: cryptoConstants.SSL_OP_NO_TICKET,
      sessionTimeout: 1,
    }, (socket) => { void this.handleSecureConnection(socket); });
    server.maxConnections = MAX_REMOTE_CONNECTIONS;
    server.on("connection", (socket) => {
      if (this.transportSockets.size >= MAX_REMOTE_CONNECTIONS) {
        socket.destroy();
        return;
      }
      this.transportSockets.add(socket);
      socket.setNoDelay(true);
      socket.setTimeout(TLS_HANDSHAKE_TIMEOUT_MS, () => socket.destroy());
      socket.once("close", () => this.transportSockets.delete(socket));
    });
    server.on("tlsClientError", () => {});
    server.on("error", () => {});
    server.on("resumeSession", (_id, callback) => callback(null, null));
    return server;
  }

  private async handleSecureConnection(socket: TLSSocket): Promise<void> {
    this.clearTransportHandshakeTimeout(socket);
    this.allRemoteSockets.add(socket);
    socket.once("close", () => this.allRemoteSockets.delete(socket));
    socket.on("error", () => {});
    if (socket.isSessionReused()) {
      socket.destroy();
      return;
    }

    const peer = socket.getPeerCertificate(true);
    const raw = peer.raw;
    if (!Buffer.isBuffer(raw) || raw.length === 0) {
      this.endPairingResponse(socket, pairingError("invalid_request", "A client certificate is required"));
      return;
    }

    let certificate: X509Certificate;
    let fingerprint: string;
    try {
      certificate = new X509Certificate(raw);
      fingerprint = certificateFingerprint(raw);
    } catch {
      socket.destroy();
      return;
    }

    const trusted = await this.options.state.trustedClient(fingerprint).catch(() => undefined);
    if (trusted && new X509Certificate(trusted.certificatePem).raw.equals(raw)) {
      this.liveRemoteSockets.set(socket, fingerprint);
      socket.once("close", () => this.liveRemoteSockets.delete(socket));
      this.options.acceptProtocolSocket(socket);
      return;
    }

    if (!this.currentPairingWindow()) {
      this.endPairingResponse(socket, pairingError("pairing_closed", "Open Devices on the Dock Host and choose Connect a New Device, then try again"));
      return;
    }
    const sourceKey = socket.remoteAddress ?? "unknown";
    if (!this.allowPairingRequest(fingerprint, sourceKey)) {
      this.endPairingResponse(socket, pairingError("busy", "Another device connection is in progress; try again shortly", PAIRING_RETRY_AFTER_MS));
      return;
    }
    this.readPairingRequest(socket, fingerprint, sourceKey, certificate);
  }

  private readPairingRequest(socket: TLSSocket, fingerprint: string, sourceKey: string, certificate: X509Certificate): void {
    const decoder = new JsonLineDecoder(MAX_PAIRING_LINE_BYTES);
    let requestSeen = false;
    let terminal = false;
    const requestTimer = setTimeout(() => {
      if (!terminal) socket.destroy();
    }, PAIRING_REQUEST_TIMEOUT_MS);
    requestTimer.unref?.();
    const hardTimer = setTimeout(() => socket.destroy(), PAIRING_CONNECTION_HARD_TIMEOUT_MS);
    hardTimer.unref?.();
    const finishTimers = (): void => {
      clearTimeout(requestTimer);
      clearTimeout(hardTimer);
    };
    socket.once("close", finishTimers);

    const fail = (record: PairingErrorRecord): void => {
      if (terminal) return;
      terminal = true;
      clearTimeout(requestTimer);
      this.endPairingResponse(socket, record);
    };

    socket.on("data", (chunk: Buffer) => {
      if (terminal) return;
      try {
        const lines = decoder.push(chunk);
        if (lines.length === 0) return;
        if (requestSeen || lines.length !== 1) {
          fail(pairingError("invalid_request", "Only one pairing request is allowed per connection"));
          return;
        }
        requestSeen = true;
        terminal = true;
        clearTimeout(requestTimer);
        socket.pause();
        let raw: unknown;
        try { raw = JSON.parse(lines[0] as string) as unknown; }
        catch {
          this.endPairingResponse(socket, pairingError("invalid_request", "Pairing request is not valid JSON"));
          return;
        }
        let request;
        try { request = parsePairingClientRecord(raw); }
        catch {
          this.endPairingResponse(socket, pairingError("invalid_request", "Pairing request is invalid"));
          return;
        }
        let task!: Promise<void>;
        task = this.processPairingRequest(request, fingerprint, sourceKey, certificate)
          .then((response) => this.endPairingResponse(socket, response))
          .catch(() => this.endPairingResponse(socket, pairingError("internal_error", "The device connection could not continue; try again")))
          .finally(() => this.inFlightPairingRequests.delete(task));
        this.inFlightPairingRequests.add(task);
      } catch {
        fail(pairingError("invalid_request", "Pairing request is too large or incomplete"));
      }
    });
    socket.on("end", () => {
      if (terminal) return;
      try { decoder.finish(); }
      catch { fail(pairingError("invalid_request", "Pairing request is incomplete")); }
    });
  }

  private async processPairingRequest(
    request: ReturnType<typeof parsePairingClientRecord>,
    fingerprint: string,
    sourceKey: string,
    certificate: X509Certificate,
  ): Promise<PairingServerRecord> {
    const window = this.currentPairingWindow();
    if (!window) return pairingError("pairing_closed", "Open Devices on the Dock Host and choose Connect a New Device, then try again");

    if (request.type === "pairing.begin.v1") {
      assertPairingCertificate(certificate);
      if (this.activePairingId) return pairingError("busy", "Another device is finishing pairing", PAIRING_RETRY_AFTER_MS);
      const existing = [...this.pending.values()].find((session) => session.fingerprint === fingerprint && !session.closed);
      if (existing) {
        if (existing.clientNonce.equals(request.clientNonce)) {
          return { type: "pairing.pending.v1", pairingId: existing.id, retryAfterMs: PAIRING_RETRY_AFTER_MS };
        }
        return pairingError("busy", "This device already has a waiting pairing request", PAIRING_RETRY_AFTER_MS);
      }
      if (this.pending.size >= MAX_PENDING_PAIRINGS) return pairingError("busy", "Another device connection is in progress; try again shortly", PAIRING_RETRY_AFTER_MS);
      const sourcePending = [...this.pending.values()].filter((session) => session.sourceKey === sourceKey && !session.closed).length;
      if (sourcePending >= MAX_PENDING_PAIRINGS_PER_SOURCE) return pairingError("busy", "Too many devices are waiting from this network; try again shortly", PAIRING_RETRY_AFTER_MS);

      const id = randomUUID();
      const expiresAt = Date.parse(window.expiresAt);
      const session: PairingSession = {
        id,
        windowId: window.id,
        deviceName: request.deviceName,
        fingerprint,
        sourceKey,
        certificatePem: certificate.toString(),
        certificateRaw: Buffer.from(certificate.raw),
        clientNonce: Buffer.from(request.clientNonce),
        expiresAt,
        requestTokens: MAX_ACTIVE_PAIRING_REQUEST_BURST,
        tokenUpdatedAt: Date.now(),
        phase: "waiting_for_approval",
        closed: false,
      };
      session.timeout = this.sessionTimeout(session, expiresAt);
      this.pending.set(id, session);
      try {
        await this.options.state.publishPending({
          schemaVersion: 1,
          id,
          windowId: window.id,
          deviceName: request.deviceName,
          fingerprint,
          requestedAt: new Date().toISOString(),
          expiresAt: window.expiresAt,
        });
      } catch (error) {
        await this.removeSession(session);
        throw error;
      }
      return { type: "pairing.pending.v1", pairingId: id, retryAfterMs: PAIRING_RETRY_AFTER_MS };
    }

    const session = this.sessionFor(request.pairingId, fingerprint, certificate.raw);
    if (!session) return pairingError("not_found", "This pairing request expired; start again");
    if (session.phase === "committing") return pairingError("busy", "Pairing is being saved; try the paired connection shortly", PAIRING_RETRY_AFTER_MS);

    if (request.type === "pairing.poll.v1") {
      if (session.phase === "waiting_for_approval") {
        return { type: "pairing.pending.v1", pairingId: session.id, retryAfterMs: PAIRING_RETRY_AFTER_MS };
      }
      if (session.phase === "waiting_for_srp_proof" && session.srp) {
        return {
          type: "pairing.srp-challenge.v1",
          pairingId: session.id,
          salt: base64(session.srp.salt),
          serverPublicKey: base64(session.srp.serverPublicKey),
        };
      }
      return pairingError("invalid_request", "Continue the current pairing step on the device");
    }

    if (request.type === "pairing.srp-proof.v1") {
      const digest = pairingRequestDigest(request);
      if (session.phase === "waiting_for_identity" && session.acceptedSrpDigest && session.serverSrpProof) {
        if (!sameBytes(digest, session.acceptedSrpDigest)) {
          await this.failApprovedPairing(session, "The device sent an unexpected connection step. Start pairing again on the device.");
          return pairingError("invalid_request", "Pairing steps arrived out of order; start again");
        }
        return { type: "pairing.srp-confirmed.v1", pairingId: session.id, proof: base64(session.serverSrpProof) };
      }
      if (session.phase !== "waiting_for_srp_proof" || !session.srp) {
        await this.failApprovedPairing(session, "The device sent an unexpected connection step. Start pairing again on the device.");
        return pairingError("invalid_request", "Pairing steps arrived out of order; start again");
      }
      try {
        const completed = completePairingSrpServer(session.srp, request.clientPublicKey, request.proof);
        session.sessionKey = completed.sessionKey;
        session.serverSrpProof = completed.serverProof;
        session.acceptedSrpDigest = digest;
        session.srp = undefined;
        session.phase = "waiting_for_identity";
        return { type: "pairing.srp-confirmed.v1", pairingId: session.id, proof: base64(completed.serverProof) };
      } catch {
        await this.failApprovedPairing(session, "That PIN did not match. Start pairing again on the device and try the new PIN.");
        return pairingError("wrong_pin", "The PIN did not match; start a new connection from Devices on the Dock Host");
      }
    }

    if (session.phase !== "waiting_for_identity" || !session.sessionKey) {
      await this.failApprovedPairing(session, "The device sent an unexpected connection step. Start pairing again on the device.");
      return pairingError("invalid_request", "Pairing steps arrived out of order; start again");
    }
    const identity = this.identity;
    if (!identity) throw new Error("Host TLS identity is unavailable");
    const hostCertificate = new X509Certificate(identity.certificatePem);
    const context = {
      pairingId: session.id,
      clientNonce: session.clientNonce,
      clientCertificate: session.certificateRaw,
      serverCertificate: hostCertificate.raw,
    };
    const verified = verifyPairingIdentity("client", session.sessionKey, context, {
      encrypted: request.encrypted,
      authTag: request.authTag,
    });
    if (!verified) {
      await this.failApprovedPairing(session, "I couldn’t verify this device. Start pairing again on the device and we’ll try once more.");
      return pairingError("invalid_request", "The device identity could not be verified; start again");
    }

    session.phase = "committing";
    const serverIdentity = createPairingIdentity("server", session.sessionKey, context, identity.privateKeyPem);
    try {
      const committed = await this.options.state.commitPairedClient(session.windowId, {
        schemaVersion: 1,
        deviceName: session.deviceName,
        fingerprint: session.fingerprint,
        certificatePem: session.certificatePem,
        pairedAt: new Date().toISOString(),
      });
      if (!committed) {
        await this.failApprovedPairing(session, "The connection closed before I could save this device. Start pairing again to retry.");
        return pairingError("pairing_closed", "The connection window closed before the device could be saved");
      }
      await this.completePairing(session);
      return {
        type: "pairing.server-identity.v1",
        pairingId: session.id,
        encrypted: base64(serverIdentity.encrypted),
        authTag: base64(serverIdentity.authTag),
      };
    } catch (error) {
      await this.options.state.revokeClient(session.fingerprint).catch(() => false);
      if (!session.closed) await this.failApprovedPairing(session, "I couldn’t save this device. Start pairing again to retry.");
      throw error;
    }
  }

  private async syncPairingWindow(listenerAvailable: boolean): Promise<void> {
    const stored = listenerAvailable ? await this.options.state.readPairingWindow() : undefined;
    const now = Date.now();
    const next = stored && Date.parse(stored.expiresAt) > now ? stored : undefined;
    if (!next) {
      // commitPairedClient claims the window by renaming it before writing trust.
      // Only that temporary absence belongs to the save; listener shutdown and an
      // expired stored window must still close pairing normally.
      const saving = this.activePairingId ? this.pending.get(this.activePairingId) : undefined;
      if (listenerAvailable && !stored && saving?.phase === "committing" && !saving.closed
        && saving.windowId === this.activeWindow?.id) return;
      if (stored) await this.options.state.closePairingWindow(stored.id).catch(() => false);
      if (this.activeWindow || this.pending.size > 0) await this.closePairingWindow(false);
      return;
    }
    if (this.activeWindow?.id === next.id) return;
    await this.clearPairingSessions();
    this.activeWindow = next;
    this.activePairingId = undefined;
    this.pairingRequestTokens = MAX_PAIRING_REQUEST_BURST;
    this.pairingTokenUpdatedAt = Date.now();
    this.pairingSourceTokens.clear();
  }

  private async consumeApprovals(): Promise<void> {
    if (this.activePairingId || !this.currentPairingWindow()) return;
    for (const session of this.pending.values()) {
      if (session.closed || session.phase !== "waiting_for_approval") continue;
      const pin = await this.options.state.consumeApproval(session.id);
      if (!pin || session.closed) continue;
      const window = this.currentPairingWindow();
      if (!window || window.id !== session.windowId) {
        await this.removeSession(session);
        return;
      }
      session.srp = createPairingSrpServer(pin);
      session.phase = "waiting_for_srp_proof";
      this.activePairingId = session.id;
      await this.options.state.writePairingProgress({
        schemaVersion: 1,
        status: "checking",
        deviceName: session.deviceName,
        updatedAt: new Date().toISOString(),
      }).catch(() => {});
      const proofDeadline = Math.min(Date.parse(window.expiresAt), Date.now() + PAIRING_PROOF_TIMEOUT_MS);
      session.expiresAt = proofDeadline;
      if (session.timeout) clearTimeout(session.timeout);
      session.timeout = this.sessionTimeout(session, proofDeadline);
      for (const candidate of [...this.pending.values()]) {
        if (candidate !== session) await this.removeSession(candidate);
      }
      return;
    }
  }

  private currentPairingWindow(): PairingWindow | undefined {
    if (!this.activeWindow || Date.parse(this.activeWindow.expiresAt) <= Date.now()) return undefined;
    return this.activeWindow;
  }

  private sessionFor(id: string, fingerprint: string, raw: Buffer): PairingSession | undefined {
    const session = this.pending.get(id);
    return session && !session.closed && session.fingerprint === fingerprint && session.certificateRaw.equals(raw) && session.windowId === this.activeWindow?.id
      ? session
      : undefined;
  }

  private allowPairingRequest(fingerprint: string, sourceKey: string): boolean {
    const active = this.activePairingId ? this.pending.get(this.activePairingId) : undefined;
    const now = Date.now();
    if (active?.fingerprint === fingerprint) {
      const elapsed = Math.max(0, now - active.tokenUpdatedAt);
      active.tokenUpdatedAt = now;
      active.requestTokens = Math.min(
        MAX_ACTIVE_PAIRING_REQUEST_BURST,
        active.requestTokens + elapsed * ACTIVE_PAIRING_REQUESTS_PER_SECOND / 1_000,
      );
      if (active.requestTokens < 1) return false;
      active.requestTokens -= 1;
      return true;
    }
    const elapsed = Math.max(0, now - this.pairingTokenUpdatedAt);
    this.pairingTokenUpdatedAt = now;
    this.pairingRequestTokens = Math.min(
      MAX_PAIRING_REQUEST_BURST,
      this.pairingRequestTokens + elapsed * PAIRING_REQUESTS_PER_SECOND / 1_000,
    );
    if (this.pairingRequestTokens < 1) return false;

    let source = this.pairingSourceTokens.get(sourceKey);
    if (!source) {
      if (this.pairingSourceTokens.size >= MAX_PAIRING_RATE_SOURCES) {
        const oldest = [...this.pairingSourceTokens.entries()].sort((left, right) => left[1].lastSeenAt - right[1].lastSeenAt)[0];
        if (oldest) this.pairingSourceTokens.delete(oldest[0]);
      }
      source = { tokens: MAX_PAIRING_REQUEST_BURST_PER_SOURCE, updatedAt: now, lastSeenAt: now };
      this.pairingSourceTokens.set(sourceKey, source);
    }
    const sourceElapsed = Math.max(0, now - source.updatedAt);
    source.tokens = Math.min(
      MAX_PAIRING_REQUEST_BURST_PER_SOURCE,
      source.tokens + sourceElapsed * PAIRING_REQUESTS_PER_SECOND_PER_SOURCE / 1_000,
    );
    source.updatedAt = now;
    source.lastSeenAt = now;
    if (source.tokens < 1) return false;
    source.tokens -= 1;
    this.pairingRequestTokens -= 1;
    return true;
  }

  private sessionTimeout(session: PairingSession, deadline: number): NodeJS.Timeout {
    const timer = setTimeout(() => {
      void this.expireSession(session);
    }, Math.max(1, deadline - Date.now()));
    timer.unref?.();
    return timer;
  }

  private async expireSession(session: PairingSession): Promise<void> {
    if (session.closed) return;
    if (session.id === this.activePairingId) {
      await this.failApprovedPairing(session, "The device took too long to finish connecting. Start pairing again when you’re ready.");
    } else await this.removeSession(session);
  }

  private async failApprovedPairing(session: PairingSession, message: string): Promise<void> {
    await this.options.state.writePairingProgress({
      schemaVersion: 1,
      status: "failed",
      deviceName: session.deviceName,
      message,
      updatedAt: new Date().toISOString(),
    }).catch(() => {});
    if (session.id === this.activePairingId) await this.closePairingWindow();
    else await this.removeSession(session);
  }

  private async completePairing(session: PairingSession): Promise<void> {
    const windowId = session.windowId;
    await this.options.state.writePairingProgress({
      schemaVersion: 1,
      status: "connected",
      deviceName: session.deviceName,
      updatedAt: new Date().toISOString(),
    }).catch(() => {});
    this.activeWindow = undefined;
    this.activePairingId = undefined;
    await this.clearPairingSessions();
    await this.options.state.closePairingWindow(windowId).catch(() => false);
  }

  private async closePairingWindow(removeState = true): Promise<void> {
    const windowId = this.activeWindow?.id;
    this.activeWindow = undefined;
    this.activePairingId = undefined;
    await this.clearPairingSessions();
    if (removeState && windowId) await this.options.state.closePairingWindow(windowId).catch(() => false);
  }

  private async clearPairingSessions(): Promise<void> {
    const sessions = [...this.pending.values()];
    this.pending.clear();
    await Promise.all(sessions.map((session) => this.removeSession(session)));
  }

  private async removeSession(session: PairingSession): Promise<void> {
    if (session.closed) return;
    session.closed = true;
    if (session.timeout) clearTimeout(session.timeout);
    if (this.pending.get(session.id) === session) this.pending.delete(session.id);
    if (this.activePairingId === session.id) this.activePairingId = undefined;
    session.sessionKey?.fill(0);
    session.acceptedSrpDigest?.fill(0);
    session.serverSrpProof?.fill(0);
    session.clientNonce.fill(0);
    await this.options.state.removePending(session.id).catch(() => {});
  }

  private endPairingResponse(socket: TLSSocket, response: PairingServerRecord): void {
    if (socket.destroyed || socket.writableEnded) return;
    const forceClose = setTimeout(() => socket.destroy(), PAIRING_RESPONSE_CLOSE_MS);
    forceClose.unref?.();
    try {
      socket.end(encodeJsonLine(response), () => {
        clearTimeout(forceClose);
        socket.destroy();
      });
    } catch {
      clearTimeout(forceClose);
      socket.destroy();
    }
  }

  private clearTransportHandshakeTimeout(socket: TLSSocket): void {
    for (const transport of this.transportSockets) {
      if (
        transport.remoteAddress === socket.remoteAddress
        && transport.remotePort === socket.remotePort
        && transport.localAddress === socket.localAddress
        && transport.localPort === socket.localPort
      ) {
        transport.setTimeout(0);
        return;
      }
    }
  }

  private async reapRevokedSockets(): Promise<void> {
    const cache = new Map<string, boolean>();
    for (const [socket, fingerprint] of this.liveRemoteSockets) {
      let trusted = cache.get(fingerprint);
      if (trusted === undefined) {
        trusted = (await this.options.state.trustedClient(fingerprint).catch(() => undefined)) !== undefined;
        cache.set(fingerprint, trusted);
      }
      if (!trusted) socket.destroy();
    }
  }

  private async recordError(configRevision: number, message: string): Promise<void> {
    await this.options.state.writeStatus({
      schemaVersion: 1,
      configRevision,
      state: "error",
      ...(this.activePort === undefined ? {} : { activePort: this.activePort }),
      message,
      updatedAt: new Date().toISOString(),
    }).catch(() => {});
  }
}

function pairingError(code: PairingErrorRecord["code"], message: string, retryAfterMs?: number): PairingErrorRecord {
  return { type: "pairing.error.v1", code, message, ...(retryAfterMs === undefined ? {} : { retryAfterMs }) };
}

function sameBytes(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && timingSafeEqual(left, right);
}

async function listen(server: TlsServer, port: number): Promise<void> {
  await new Promise<void>((resolveListen, rejectListen) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      rejectListen(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolveListen();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen({ host: "::", port, ipv6Only: false });
  });
}

async function closeServer(server: TlsServer): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
}

function humanError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[\r\n\u0000-\u001f\u007f]/gu, " ").slice(0, 1000) || "Remote access failed";
}
