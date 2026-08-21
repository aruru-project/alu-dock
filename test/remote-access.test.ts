import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes, X509Certificate } from "node:crypto";
import { chmod, lstat, mkdtemp, readFile, rm } from "node:fs/promises";
import { createConnection as createNetConnection, createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, type TLSSocket } from "node:tls";
import test from "node:test";

import { DockClient } from "../src/control/dock-client.js";
import { AttachmentService } from "../src/control/attachment-service.js";
import { AttachmentStorageState } from "../src/control/attachment-storage-state.js";
import { DockHost } from "../src/control/dock-host.js";
import type { MainRouteAuthority } from "../src/control/machine-transport.js";
import { DockRegistry } from "../src/control/dock-registry.js";
import { encodeJsonLine } from "../src/control/json-lines.js";
import {
  base64,
  completePairingSrpServer,
  confirmPairingSrpClient,
  createPairingIdentity,
  createPairingSrpClient,
  createPairingSrpServer,
  verifyPairingIdentity,
} from "../src/control/remote-pairing.js";
import { RemoteAccessState, type TrustedClient } from "../src/control/remote-access-state.js";
import { ManagedInstance } from "../src/core/managed-instance.js";
import { DelayedAgentWorkerConnection } from "./support/delayed-agent-worker.js";
import { ptyUserEnvironment } from "./support/pty-user-environment.js";

class BarrierRemoteAccessState extends RemoteAccessState {
  private barrier: { started: () => void; wait: Promise<void> } | undefined;
  private trustStarted: Promise<void> | undefined;
  trustWriteAttempts = 0;

  armTrustBarrier(): () => void {
    let release!: () => void;
    let started!: () => void;
    this.trustStarted = new Promise<void>((resolveStarted) => { started = resolveStarted; });
    const wait = new Promise<void>((resolveRelease) => { release = resolveRelease; });
    this.barrier = { started, wait };
    return release;
  }

  async waitForBlockedTrust(): Promise<void> {
    if (!this.trustStarted) throw new Error("Trust barrier is not armed");
    await this.trustStarted;
  }

  override async trustClient(client: TrustedClient): Promise<void> {
    this.trustWriteAttempts += 1;
    const barrier = this.barrier;
    if (barrier) {
      barrier.started();
      await barrier.wait;
      if (this.barrier === barrier) this.barrier = undefined;
    }
    await super.trustClient(client);
  }
}

class LineReader {
  private buffer = "";
  private readonly queued: unknown[] = [];
  private readonly waiters: Array<{ resolve: (value: unknown) => void; reject: (error: Error) => void }> = [];
  private closed = false;

  constructor(private readonly socket: TLSSocket) {
    socket.on("data", (chunk: Buffer) => {
      this.buffer += chunk.toString("utf8");
      while (true) {
        const newline = this.buffer.indexOf("\n");
        if (newline < 0) break;
        const line = this.buffer.slice(0, newline);
        this.buffer = this.buffer.slice(newline + 1);
        const value = JSON.parse(line) as unknown;
        const waiter = this.waiters.shift();
        if (waiter) waiter.resolve(value);
        else this.queued.push(value);
      }
    });
    socket.once("error", (error) => this.rejectAll(error));
    socket.once("close", () => {
      this.closed = true;
      this.rejectAll(new Error("TLS connection closed before a complete JSONL response"));
    });
  }

  next(timeoutMs = 3_000): Promise<unknown> {
    const value = this.queued.shift();
    if (value !== undefined) return Promise.resolve(value);
    if (this.closed) return Promise.reject(new Error("TLS connection is closed"));
    return new Promise((resolveValue, rejectValue) => {
      const timer = setTimeout(() => rejectValue(new Error("Timed out waiting for TLS JSONL response")), timeoutMs);
      this.waiters.push({
        resolve: (result) => { clearTimeout(timer); resolveValue(result); },
        reject: (error) => { clearTimeout(timer); rejectValue(error); },
      });
    });
  }

  private rejectAll(error: Error): void {
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
  }
}

test("HomeKit-style SRP rejects a wrong four-digit PIN", () => {
  const server = createPairingSrpServer("1234");
  const wrongClient = createPairingSrpClient("9999", server.salt, server.serverPublicKey);
  assert.throws(
    () => completePairingSrpServer(server, wrongClient.clientPublicKey, wrongClient.proof),
    /same password/u,
  );
});

test("an expected pairing-window close cannot remove a newer window", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "alu-dock-pairing-window-"));
  await chmod(directory, 0o700);
  context.after(async () => rm(directory, { recursive: true, force: true }));
  const state = new RemoteAccessState(join(directory, "remote-access"));
  const first = await state.openPairingWindow();
  const second = await state.openPairingWindow();
  assert.equal(await state.closePairingWindow(first.id), false);
  assert.equal((await state.readPairingWindow())?.id, second.id);
  assert.equal(await state.closePairingWindow(second.id), true);
  assert.equal(await state.readPairingWindow(), undefined);
});

test("machine-listener startup failure rolls back Unix and Remote Access listeners", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "alu-dock-start-rollback-"));
  await chmod(directory, 0o700);
  context.after(async () => rm(directory, { recursive: true, force: true }));
  const socketPath = join(directory, "dock.sock");
  const port = await reservePort();
  const remoteAccessState = new RemoteAccessState(join(directory, "remote-access"));
  await remoteAccessState.writeSettings({ enabled: true, port });
  const registry = new DockRegistry(async () => { throw new Error("startup rollback must not construct a runtime"); });
  let stopCalls = 0;
  const routeAuthority = {
    route: async () => ({ kind: "local" as const }),
    machines: async () => [],
    listPage: async () => ({ instances: [] }),
    start: async () => {
      assert.equal((await lstat(socketPath)).isSocket(), true);
      assert.equal(await tcpConnects("::1", port), true);
      throw new Error("fixture machine listener failed");
    },
    stop: async () => { stopCalls += 1; },
  } as MainRouteAuthority;
  const host = new DockHost({ socketPath, registry, remoteAccessState, routeAuthority });

  await assert.rejects(host.start(), /fixture machine listener failed/u);
  assert.equal(stopCalls, 1);
  await assert.rejects(lstat(socketPath), (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT");
  assert.equal(await tcpConnects("::1", port), false);
});

test("local pairing window admits an exact certificate to the existing Protocol V2 TLS path", { timeout: 55_000 }, async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "alu-dock-remote-"));
  await chmod(directory, 0o700);
  const socketPath = join(directory, "dock.sock");
  const stateHome = join(directory, "state");
  const state = new BarrierRemoteAccessState(join(stateHome, "alu-dock", "remote-access"));
  const clientIdentityState = new RemoteAccessState(join(directory, "client-identity"));
  const clientIdentity = await clientIdentityState.ensureHostIdentity();
  const clientCertificate = new X509Certificate(clientIdentity.certificatePem);
  const port = await reservePort();
  const configuredAttachmentDirectory = join(directory, "Hub configured attachments");
  const attachmentService = new AttachmentService(new AttachmentStorageState(join(stateHome, "alu-dock"), join(directory, "attachments")));
  const registry = new DockRegistry(async ({ id, creationOperationId, hostEpoch, cwd }) => (
    new ManagedInstance({ id, creationOperationId, hostEpoch, cwd, session: new DelayedAgentWorkerConnection(`pi-${id}`) })
  ), undefined, { attachmentHostPort: attachmentService });
  const host = new DockHost({ socketPath, registry, remoteAccessState: state, attachmentService });
  context.after(async () => {
    await host.stop().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  });
  await host.start();
  await waitFor(async () => (await state.readStatus())?.state === "disabled");

  const settingsPty = await runHubPty(socketPath, "hub-remote-settings", directory, { ALU_DOCK_PTY_PORT: String(port) });
  assertPty(settingsPty);
  assert.match(settingsPty.output, /Devices/u);
  assert.match(settingsPty.output, /Remote Access · On/u);
  await waitFor(async () => (await state.readStatus())?.state === "listening");
  const attachmentSettingsPty = await runHubPty(socketPath, "hub-attachment-settings", directory, { ALU_DOCK_PTY_ATTACHMENT_DIR: configuredAttachmentDirectory });
  assertPty(attachmentSettingsPty);
  assert.match(attachmentSettingsPty.output, /keep new attachments/u);

  const handshakeStart = Date.now();
  const stalledHandshake = createNetConnection({ host: "::1", port });
  await new Promise<void>((resolveClosed, rejectClosed) => {
    const timeout = setTimeout(() => {
      stalledHandshake.destroy();
      rejectClosed(new Error("TLS handshake remained open beyond its hard deadline"));
    }, 6_500);
    stalledHandshake.once("close", () => {
      clearTimeout(timeout);
      resolveClosed();
    });
    stalledHandshake.once("error", () => {});
  });
  assert.ok(Date.now() - handshakeStart < 6_500, "TLS handshake timeout must be bounded near five seconds");

  const unixInfo = await new DockClient({ socketPath }).hostInfo();
  assert.equal(unixInfo.state, "ready", "network TLS must not replace the private Unix socket");

  const closed = await pairingRequest("::1", port, clientIdentity, hello("unknown-hello"));
  assert.equal(closed.response.type, "pairing.error.v1");
  assert.equal(closed.response.code, "pairing_closed");
  assert.equal("host" in closed.response, false, "an unknown certificate must never receive Protocol V2 Host data");

  const openPty = await runHubPty(socketPath, "hub-pairing-open", directory);
  assertPty(openPty);
  assert.match(openPty.output, /Connect a New Device\?/u);
  assert.match(openPty.output, /Waiting for your device/u);
  await waitFor(async () => {
    const pairingWindow = await state.readPairingWindow();
    return pairingWindow !== undefined && Date.parse(pairingWindow.expiresAt) > Date.now();
  });

  const autoUpdatePty = await runHubPty(socketPath, "hub-devices-auto-update", directory);
  assertPty(autoUpdatePty);
  assert.match(autoUpdatePty.output, /Bedroom phone/u, "a device published while Devices is visible must appear without a keypress");
  assert.doesNotMatch(autoUpdatePty.output, /Refresh/u);
  await state.removePending("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");

  const idleUnknown = await openTls("::1", port, clientIdentity);
  const idleStarted = Date.now();
  await new Promise<void>((resolveClosed, rejectClosed) => {
    const timeout = setTimeout(() => {
      idleUnknown.destroy();
      rejectClosed(new Error("unknown TLS client remained open without a pairing request"));
    }, 3_000);
    idleUnknown.once("close", () => {
      clearTimeout(timeout);
      resolveClosed();
    });
  });
  assert.ok(Date.now() - idleStarted < 3_000, "an unknown client must send its one request within two seconds");
  assert.equal((await state.listPending()).length, 0);

  const pin = "1234";
  const clientNonce = randomBytes(16);
  const begin = await pairingRequest("::1", port, clientIdentity, {
    type: "pairing.begin.v1",
    deviceName: "Living room tablet",
    clientNonce: base64(clientNonce),
  });
  assert.equal(begin.response.type, "pairing.pending.v1");
  assert.equal(typeof begin.response.pairingId, "string");
  const pairingId = begin.response.pairingId as string;
  const hostCertificateRaw = begin.serverCertificate;
  assert.ok(hostCertificateRaw.length > 0);
  await waitFor(async () => (await state.listPending()).some((request) => request.id === pairingId));

  const stillPending = await pairingRequest("::1", port, clientIdentity, {
    type: "pairing.poll.v1",
    pairingId,
  }, hostCertificateRaw);
  assert.equal(stillPending.response.type, "pairing.pending.v1");

  const pairingPty = await runHubPty(socketPath, "hub-pairing", directory, { ALU_DOCK_PTY_PIN: pin });
  assertPty(pairingPty);
  assert.match(pairingPty.output, /Type the 4-digit PIN/u);
  assert.match(pairingPty.output, /Just a moment/u);
  assert.doesNotMatch(pairingPty.output, /Enter Pairing PIN|Confirm Pairing/u);

  let challenge: Record<string, unknown> | undefined;
  await waitFor(async () => {
    const polled = await pairingRequest("::1", port, clientIdentity, {
      type: "pairing.poll.v1",
      pairingId,
    }, hostCertificateRaw);
    if (polled.response.type === "pairing.srp-challenge.v1") {
      challenge = polled.response;
      return true;
    }
    return false;
  }, 4_000, 100);
  assert.ok(challenge);

  const clientSrp = createPairingSrpClient(
    pin,
    Buffer.from(challenge.salt as string, "base64"),
    Buffer.from(challenge.serverPublicKey as string, "base64"),
  );
  const srpProofRequest = {
    type: "pairing.srp-proof.v1",
    pairingId,
    clientPublicKey: base64(clientSrp.clientPublicKey),
    proof: base64(clientSrp.proof),
  };
  const confirmed = await pairingRequest("127.0.0.1", port, clientIdentity, srpProofRequest, hostCertificateRaw);
  assert.equal(confirmed.response.type, "pairing.srp-confirmed.v1");

  // A lost SRP response is recoverable without advancing the state twice.
  const duplicate = await pairingRequest("::1", port, clientIdentity, srpProofRequest, hostCertificateRaw);
  assert.deepEqual(duplicate.response, confirmed.response);
  const sessionKey = confirmPairingSrpClient(clientSrp, Buffer.from(confirmed.response.proof as string, "base64"));

  const identityContext = {
    pairingId,
    clientNonce,
    clientCertificate: clientCertificate.raw,
    serverCertificate: hostCertificateRaw,
  };
  const clientProof = createPairingIdentity("client", sessionKey, identityContext, clientIdentity.privateKeyPem);
  assert.equal(verifyPairingIdentity("client", sessionKey, {
    ...identityContext,
    serverCertificate: clientCertificate.raw,
  }, clientProof), false, "a relayed proof must not survive Host certificate substitution");

  const serverIdentity = await pairingRequest("127.0.0.1", port, clientIdentity, {
    type: "pairing.client-identity.v1",
    pairingId,
    encrypted: base64(clientProof.encrypted),
    authTag: base64(clientProof.authTag),
  }, hostCertificateRaw);
  assert.equal(serverIdentity.response.type, "pairing.server-identity.v1");
  assert.equal(verifyPairingIdentity("server", sessionKey, identityContext, {
    encrypted: Buffer.from(serverIdentity.response.encrypted as string, "base64"),
    authTag: Buffer.from(serverIdentity.response.authTag as string, "base64"),
  }), true, "the client must authenticate the exact Host certificate before pinning it");
  sessionKey.fill(0);

  await waitFor(async () => (await state.trustedClient(clientIdentity.fingerprint)) !== undefined);
  assert.deepEqual((await state.readPairingProgress())?.status, "connected");
  assert.equal(await state.readPairingWindow(), undefined, "a successful pairing must close its local window");
  assert.equal((await state.listPending()).length, 0);

  // Pairing used both IPv6 and IPv4. The exact same certificates now reach the unchanged Protocol V2 path.
  const trusted = await openTls("127.0.0.1", port, clientIdentity, hostCertificateRaw);
  const trustedReader = new LineReader(trusted);
  trusted.write(encodeJsonLine(hello("trusted-hello")));
  const ack = record(await trustedReader.next());
  assert.equal(ack.kind, "hello_ack");
  // Regression: on 2026-08-17 clients reported that trusted links were cut after five idle seconds.
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 5_250));
  assert.equal(trusted.destroyed, false, "a trusted Protocol V2 connection must remain open while idle");
  trusted.write(encodeJsonLine({ kind: "request", version: 2, requestId: "host-info", type: "host.info", params: {} }));
  const response = record(await trustedReader.next());
  assert.equal(response.kind, "response");
  assert.equal(record(response.result).state, "ready");
  trusted.destroy();

  const uploadBytes = Buffer.from("remote attachment bytes");
  const uploadDigest = createHash("sha256").update(uploadBytes).digest("hex");
  const upload = await openTls("::1", port, clientIdentity, hostCertificateRaw);
  const uploadReader = new LineReader(upload);
  upload.write(encodeJsonLine({ ...record(hello("upload-hello")), requiredCapabilities: ["attachments.v1"] }));
  assert.equal(record(await uploadReader.next()).kind, "hello_ack");
  upload.write(encodeJsonLine({ kind: "request", version: 2, requestId: "remote-upload", type: "attachment.upload", params: {
    operationId: "remote-upload-operation", instanceId: "remote-instance", name: "remote file.bin", sizeBytes: uploadBytes.length, sha256: uploadDigest,
  } }));
  assert.equal(record(await uploadReader.next()).kind, "attachment_upload_ready");
  upload.write(encodeJsonLine({ kind: "attachment_chunk", version: 2, requestId: "remote-upload", index: 0, data: uploadBytes.toString("base64") }));
  upload.write(encodeJsonLine({ kind: "attachment_complete", version: 2, requestId: "remote-upload", chunks: 1 }));
  const uploadResponse = record(await uploadReader.next());
  assert.equal(uploadResponse.kind, "response");
  assert.equal(uploadResponse.ok, true);
  const uploadResult = record(uploadResponse.result);
  assert.equal(uploadResult.status, "stored");
  const uploadedAttachment = record(uploadResult.attachment);
  assert.equal(uploadedAttachment.sha256, uploadDigest);
  const resolvedUpload = await attachmentService.accessAttachments("remote-instance", { type: "resolve", fileId: uploadedAttachment.fileId as string });
  assert.equal(resolvedUpload.type, "resolve");
  if (resolvedUpload.type === "resolve") {
    assert.ok(resolvedUpload.path.startsWith(`${configuredAttachmentDirectory}/`));
    assert.deepEqual(await readFile(resolvedUpload.path), uploadBytes);
  }
  upload.destroy();

  const held = await openTls("::1", port, clientIdentity, hostCertificateRaw);
  const heldReader = new LineReader(held);
  held.write(encodeJsonLine(hello("held-hello")));
  assert.equal(record(await heldReader.next()).kind, "hello_ack");
  const heldClosed = new Promise<void>((resolveClosed) => held.once("close", () => resolveClosed()));
  const revokePty = await runHubPty(socketPath, "hub-revoke", directory);
  assertPty(revokePty);
  assert.match(revokePty.output, /Remove Living room tablet\?/u);
  assert.match(revokePty.output, /Living room tablet has been removed/u);
  assert.doesNotMatch(revokePty.output, /Revoke Access|Revoke This Device/u);
  await Promise.race([
    heldClosed,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("revoked TLS connection remained open")), 2_000)),
  ]);

  const revoked = await pairingRequest("127.0.0.1", port, clientIdentity, hello("revoked-hello"), hostCertificateRaw);
  assert.equal(revoked.response.type, "pairing.error.v1");
  assert.equal(revoked.response.code, "pairing_closed");

  const raceIdentityState = new RemoteAccessState(join(directory, "race-client-identity"));
  const raceIdentity = await raceIdentityState.ensureHostIdentity();
  const raceAttempt = await preparePairingIdentity(state, port, raceIdentity, "4826", hostCertificateRaw, "Race test tablet");
  const trustAttemptsBeforeRace = state.trustWriteAttempts;
  const releaseTrust = state.armTrustBarrier();
  const committing = pairingRequest("::1", port, raceIdentity, raceAttempt.identityRequest, hostCertificateRaw);
  await state.waitForBlockedTrust();
  const concurrent = await pairingRequest("::1", port, raceIdentity, raceAttempt.identityRequest, hostCertificateRaw);
  assert.equal(concurrent.response.type, "pairing.error.v1");
  assert.equal(concurrent.response.code, "busy", "only one final trust commit may run");
  assert.equal(await state.closePairingWindow(raceAttempt.windowId), false, "the final commit atomically claims the window before writing trust");
  releaseTrust();
  const committedRace = await committing;
  assert.equal(committedRace.response.type, "pairing.server-identity.v1");
  await waitFor(async () => (await state.trustedClient(raceIdentity.fingerprint)) !== undefined);
  assert.equal(state.trustWriteAttempts, trustAttemptsBeforeRace + 1, "concurrent final records must not start another trust write");
  assert.equal(await state.revokeClient(raceIdentity.fingerprint), true);
  raceAttempt.sessionKey.fill(0);

  // If local close wins the atomic window claim, an immediate final request cannot persist trust even before the Host poll runs.
  const cancelledAttempt = await preparePairingIdentity(state, port, raceIdentity, "2604", hostCertificateRaw, "Cancelled tablet");
  assert.equal(await state.closePairingWindow(cancelledAttempt.windowId), true);
  const cancelledCommit = await pairingRequest("::1", port, raceIdentity, cancelledAttempt.identityRequest, hostCertificateRaw);
  assert.equal(cancelledCommit.response.type, "pairing.error.v1");
  assert.equal(cancelledCommit.response.code, "pairing_closed");
  assert.equal(await state.trustedClient(raceIdentity.fingerprint), undefined);
  cancelledAttempt.sessionKey.fill(0);

  // If the authenticated final response is lost, the Sunshine-style final mTLS probe recovers the committed result.
  const lostFinal = await preparePairingIdentity(state, port, raceIdentity, "7315", hostCertificateRaw, "Recovery tablet");
  const dropped = await openTls("127.0.0.1", port, raceIdentity, hostCertificateRaw);
  await new Promise<void>((resolveWrite, rejectWrite) => {
    dropped.write(encodeJsonLine(lostFinal.identityRequest), (error) => {
      if (error) rejectWrite(error);
      else resolveWrite();
    });
  });
  dropped.destroy();
  await waitFor(async () => (await state.trustedClient(raceIdentity.fingerprint)) !== undefined, 4_000);
  const recovered = await openTls("::1", port, raceIdentity, hostCertificateRaw);
  const recoveredReader = new LineReader(recovered);
  recovered.write(encodeJsonLine(hello("recover-lost-final")));
  assert.equal(record(await recoveredReader.next()).kind, "hello_ack");
  recovered.destroy();
  lostFinal.sessionKey.fill(0);
  assert.equal(await state.revokeClient(raceIdentity.fingerprint), true);

  // A failed port migration must not leave the old network ingress silently active.
  const occupiedPort = await reservePort();
  const blocker = createNetServer();
  await new Promise<void>((resolveListen, rejectListen) => {
    blocker.once("error", rejectListen);
    blocker.listen({ host: "::", port: occupiedPort, ipv6Only: false }, resolveListen);
  });
  const changed = await state.writeSettings({ enabled: true, port: occupiedPort });
  await waitFor(async () => {
    const status = await state.readStatus();
    return status?.configRevision === changed.revision && status.state === "error";
  }, 4_000);
  assert.equal(await tcpConnects("::1", port), false, "the previous TLS port must close when replacement bind fails");
  await new Promise<void>((resolveClose) => blocker.close(() => resolveClose()));
});

interface HubPtyResult {
  status: number;
  timedOut: boolean;
  output: string;
}

interface PairingRequestResult {
  response: Record<string, unknown>;
  serverCertificate: Buffer;
}

interface PreparedPairingIdentity {
  windowId: string;
  identityRequest: {
    type: "pairing.client-identity.v1";
    pairingId: string;
    encrypted: string;
    authTag: string;
  };
  sessionKey: Buffer;
}

async function preparePairingIdentity(
  state: RemoteAccessState,
  port: number,
  identity: { certificatePem: string; privateKeyPem: string },
  pin: string,
  hostCertificate: Buffer,
  deviceName: string,
): Promise<PreparedPairingIdentity> {
  const pairingWindow = await state.openPairingWindow();
  const clientNonce = randomBytes(16);
  let begin: PairingRequestResult | undefined;
  await waitFor(async () => {
    const response = await pairingRequest("::1", port, identity, {
      type: "pairing.begin.v1",
      deviceName,
      clientNonce: base64(clientNonce),
    }, hostCertificate);
    if (response.response.type !== "pairing.pending.v1") return false;
    begin = response;
    return true;
  }, 4_000, 100);
  assert.ok(begin);
  const pairingId = begin.response.pairingId as string;
  await state.approvePairing(pairingId, pin);

  let challenge: Record<string, unknown> | undefined;
  await waitFor(async () => {
    const response = await pairingRequest("127.0.0.1", port, identity, {
      type: "pairing.poll.v1",
      pairingId,
    }, hostCertificate);
    if (response.response.type !== "pairing.srp-challenge.v1") return false;
    challenge = response.response;
    return true;
  }, 4_000, 100);
  assert.ok(challenge);
  const clientSrp = createPairingSrpClient(
    pin,
    Buffer.from(challenge.salt as string, "base64"),
    Buffer.from(challenge.serverPublicKey as string, "base64"),
  );
  const confirmed = await pairingRequest("::1", port, identity, {
    type: "pairing.srp-proof.v1",
    pairingId,
    clientPublicKey: base64(clientSrp.clientPublicKey),
    proof: base64(clientSrp.proof),
  }, hostCertificate);
  assert.equal(confirmed.response.type, "pairing.srp-confirmed.v1");
  const sessionKey = confirmPairingSrpClient(clientSrp, Buffer.from(confirmed.response.proof as string, "base64"));
  const clientCertificate = new X509Certificate(identity.certificatePem);
  const proof = createPairingIdentity("client", sessionKey, {
    pairingId,
    clientNonce,
    clientCertificate: clientCertificate.raw,
    serverCertificate: hostCertificate,
  }, identity.privateKeyPem);
  return {
    windowId: pairingWindow.id,
    identityRequest: {
      type: "pairing.client-identity.v1",
      pairingId,
      encrypted: base64(proof.encrypted),
      authTag: base64(proof.authTag),
    },
    sessionKey,
  };
}

async function pairingRequest(
  host: string,
  port: number,
  identity: { certificatePem: string; privateKeyPem: string },
  request: unknown,
  expectedServerCertificate?: Buffer,
): Promise<PairingRequestResult> {
  const socket = await openTls(host, port, identity, expectedServerCertificate);
  const serverCertificate = socket.getPeerCertificate(true).raw;
  assert.ok(Buffer.isBuffer(serverCertificate) && serverCertificate.length > 0);
  const reader = new LineReader(socket);
  const closed = new Promise<void>((resolveClosed) => socket.once("close", () => resolveClosed()));
  socket.write(encodeJsonLine(request));
  const response = record(await reader.next());
  await Promise.race([
    closed,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("untrusted pairing socket remained open")), 1_500)),
  ]);
  return { response, serverCertificate: Buffer.from(serverCertificate) };
}

async function runHubPty(
  socketPath: string,
  action: "hub-remote-settings" | "hub-attachment-settings" | "hub-pairing-open" | "hub-devices-auto-update" | "hub-pairing" | "hub-revoke",
  environmentRoot: string,
  overrides: Record<string, string> = {},
): Promise<HubPtyResult> {
  const environment = await ptyUserEnvironment(environmentRoot, {
    ALU_DOCK_PTY_ACTION: action,
    ...overrides,
  });
  return new Promise((resolveRun, rejectRun) => {
    const driver = join(process.cwd(), "test/fixtures/pty-tui-driver.py");
    const child = spawn("python3", [
      driver,
      process.execPath,
      join(process.cwd(), "dist/src/cli.js"),
      "--socket",
      socketPath,
    ], {
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", rejectRun);
    child.once("close", (code) => {
      if (code !== 0) {
        rejectRun(new Error(`PTY driver failed (${code ?? "signal"}): ${Buffer.concat(stderr).toString("utf8")}`));
        return;
      }
      try {
        const parsed = JSON.parse(Buffer.concat(stdout).toString("utf8")) as Record<string, unknown>;
        assert.equal(typeof parsed.status, "number");
        assert.equal(typeof parsed.timedOut, "boolean");
        assert.equal(typeof parsed.output, "string");
        resolveRun({
          status: parsed.status as number,
          timedOut: parsed.timedOut as boolean,
          output: Buffer.from(parsed.output as string, "base64").toString("utf8"),
        });
      } catch (error) {
        rejectRun(new Error(`Invalid PTY driver result: ${Buffer.concat(stdout).toString("utf8")}\n${Buffer.concat(stderr).toString("utf8")}`, { cause: error }));
      }
    });
  });
}

function assertPty(result: HubPtyResult): void {
  assert.equal(result.timedOut, false, result.output.slice(-4_000));
  assert.equal(result.status, 0, result.output.slice(-4_000));
}

function hello(requestId: string): unknown {
  return {
    kind: "hello",
    requestId,
    versions: [2],
    client: { name: "remote-test", version: "1", clientId: "remote-test-client" },
    requiredCapabilities: [],
  };
}

async function openTls(
  host: string,
  port: number,
  identity: { certificatePem: string; privateKeyPem: string },
  expectedServerCertificate?: Buffer,
): Promise<TLSSocket> {
  return new Promise((resolveSocket, rejectSocket) => {
    // The first pairing request has no Host pin yet. Every later request checks
    // the exact provisional DER before sending application data.
    const socket = connect({
      host,
      port,
      cert: identity.certificatePem,
      key: identity.privateKeyPem,
      rejectUnauthorized: false,
      servername: "alu-dock",
    });
    const timer = setTimeout(() => {
      socket.destroy();
      rejectSocket(new Error("Timed out establishing TLS connection"));
    }, 6_000);
    const onError = (error: Error): void => {
      clearTimeout(timer);
      rejectSocket(error);
    };
    socket.once("error", onError);
    socket.once("secureConnect", () => {
      clearTimeout(timer);
      socket.off("error", onError);
      socket.on("error", () => {});
      const peer = socket.getPeerCertificate(true).raw;
      if (!Buffer.isBuffer(peer) || peer.length === 0 || (expectedServerCertificate && !peer.equals(expectedServerCertificate))) {
        socket.destroy();
        rejectSocket(new Error("TLS Host certificate did not match the paired Host"));
        return;
      }
      resolveSocket(socket);
    });
  });
}

async function tcpConnects(host: string, port: number): Promise<boolean> {
  return new Promise((resolveResult) => {
    const socket = createNetConnection({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      resolveResult(false);
    }, 1_000);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.destroy();
      resolveResult(true);
    });
    socket.once("error", () => {
      clearTimeout(timer);
      resolveResult(false);
    });
  });
}

async function reservePort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen({ host: "::", port: 0, ipv6Only: false }, resolveListen);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  return address.port;
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 3_000, intervalMs = 25): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, intervalMs));
  }
  throw new Error("Timed out waiting for remote access state");
}

function record(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}
