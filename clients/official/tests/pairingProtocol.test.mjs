// Real Rust public API against a loopback TLS peer. Crypto/framing comes from
// the production Host helpers; no Host service, Worker, model or user credentials.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash, randomUUID, X509Certificate } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:tls'
import { createInterface } from 'node:readline'
import { generateHostIdentity } from '../../../dist/src/control/remote-access-state.js'
import { createPairingSrpServer, completePairingSrpServer, createPairingIdentity, verifyPairingIdentity, parsePairingClientRecord } from '../../../dist/src/control/remote-pairing.js'

const directory = await mkdtemp(join(tmpdir(), 'aludock-pairing-flow-'))
const identity = await generateHostIdentity()
const sessions = new Map(), fingerprints = new Set(), trusted = new Set(), sockets = new Set()
let current, saved, child, stderr = '', failure
const fingerprint = cert => createHash('sha256').update(cert).digest('hex')
const send = (socket, value) => socket.write(`${JSON.stringify(value)}\n`)
const server = createServer({ cert: identity.certificatePem, key: identity.privateKeyPem, requestCert: true, rejectUnauthorized: false }, socket => {
  sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {})
  const peer = socket.getPeerCertificate().raw
  const lines = createInterface({ input: socket })
  lines.on('line', line => {
    try {
      const value = JSON.parse(line)
      if (value.kind === 'hello') {
        assert.ok(trusted.has(fingerprint(peer)), 'final confirmation uses the fully authenticated client certificate')
        if (current.mode === 'confirmation_failed') { socket.destroy(); return }
        send(socket, { kind: 'hello_ack', requestId: value.requestId, version: 2, catalogSchemaVersion: 1, host: { hostEpoch: 'pairing-fixture' }, capabilities: value.requiredCapabilities, limits: { maxLineBytes: 1048576 } })
        return
      }
      if (value.kind === 'request') {
        assert.equal(value.type, 'host.info')
        send(socket, { kind: 'response', version: 2, requestId: value.requestId, hostEpoch: 'pairing-fixture', ok: true, result: { state: 'running', host: { pid: 1, dockVersion: 'fixture', piSdkVersion: 'fixture', hostEpoch: 'pairing-fixture', startedAt: '2026-09-01T00:00:00Z' }, catalog: {}, paths: {}, diagnostics: [] } })
        return
      }
      const record = parsePairingClientRecord(value)
      if (record.type === 'pairing.begin.v1') {
        assert.ok(!fingerprints.has(fingerprint(peer)), 'every explicit attempt creates a fresh client identity')
        fingerprints.add(fingerprint(peer))
        current = { id: randomUUID(), mode: record.deviceName, clientNonce: record.clientNonce, clientCertificate: peer }
        sessions.set(current.id, current)
        send(socket, { type: 'pairing.pending.v1', pairingId: current.id, retryAfterMs: 100 })
        return
      }
      const session = sessions.get(record.pairingId)
      assert.ok(session)
      assert.deepEqual(peer, session.clientCertificate)
      if (record.type === 'pairing.poll.v1') {
        assert.ok(session.srp, 'PIN was delivered to the local approving fixture')
        send(socket, { type: 'pairing.srp-challenge.v1', pairingId: session.id, salt: session.srp.salt.toString('base64'), serverPublicKey: session.srp.serverPublicKey.toString('base64') })
      } else if (record.type === 'pairing.srp-proof.v1') {
        const result = completePairingSrpServer(session.srp, record.clientPublicKey, record.proof)
        session.key = result.sessionKey
        send(socket, { type: 'pairing.srp-confirmed.v1', pairingId: session.id, proof: result.serverProof.toString('base64') })
      } else if (record.type === 'pairing.client-identity.v1') {
        const context = { pairingId: session.id, clientNonce: session.clientNonce, clientCertificate: peer, serverCertificate: new X509Certificate(identity.certificatePem).raw }
        assert.ok(verifyPairingIdentity('client', session.key, context, record))
        trusted.add(fingerprint(peer))
        // Lost final replies may leave unused Host trust: explicitly accepted.
        if (session.mode.endsWith('lost')) { socket.destroy(); return }
        const result = createPairingIdentity('server', session.key, context, identity.privateKeyPem)
        if (session.mode === 'tampered') result.authTag[0] ^= 1
        send(socket, { type: 'pairing.server-identity.v1', pairingId: session.id, encrypted: result.encrypted.toString('base64'), authTag: result.authTag.toString('base64') })
      }
    } catch (error) { failure = error; socket.destroy(); child?.kill() }
  })
})
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const endpoint = `127.0.0.1:${server.address().port}`
  child = spawn('cargo', ['run', '--locked', '-p', 'aludock-client-core', '--example', 'pairing_lifecycle', '--', endpoint, join(directory, 'client')], {
    cwd: new URL('../', import.meta.url), stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, HOME: directory, CARGO_HOME: process.env.CARGO_HOME ?? join(homedir(), '.cargo'), RUSTUP_HOME: process.env.RUSTUP_HOME ?? join(homedir(), '.rustup'), XDG_CONFIG_HOME: join(directory, 'config'), XDG_STATE_HOME: join(directory, 'state'), XDG_DATA_HOME: join(directory, 'data'), PI_CODING_AGENT_DIR: join(directory, 'pi') },
  })
  child.stderr.on('data', chunk => { stderr += chunk })
  createInterface({ input: child.stdout }).on('line', line => {
    const result = JSON.parse(line)
    if (result.pin) current.srp = createPairingSrpServer(result.pin)
    if (result.savedFingerprint) saved = result
  })
  const timer = setTimeout(() => { failure = new Error('pairing fixture timed out'); child.kill() }, 60000)
  const code = await new Promise(resolve => child.on('exit', resolve))
  clearTimeout(timer)
  if (failure) throw failure
  assert.equal(code, 0, stderr)
  assert.equal(saved.savedFingerprint, fingerprint([...sessions.values()].find(session => session.mode === 'success').clientCertificate))
  assert.ok(trusted.has(saved.savedFingerprint))
  console.log('Full pairing proof, lost/tampered response, cancellation, fresh retry and saved identity passed')
} finally {
  child?.kill()
  for (const socket of sockets) socket.destroy()
  await new Promise(resolve => server.close(resolve))
  await rm(directory, { recursive: true, force: true })
}
