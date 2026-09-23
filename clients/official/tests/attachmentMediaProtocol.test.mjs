// Send uploaded photos and see the same originals live and after SDK reload.
// Run after building core example protocol_attachment_media (cargo discovers it
// automatically). ALUDOCK_TEST_HOST_ROOT selects a built Host tree; optional
// ALUDOCK_ATTACHMENT_READER selects the example binary. KEEP=1 retains evidence.
// Only the external model transport is replaced, with the loopback SSE pattern
// from test/pi-sdk-compat/pi-sdk-upgrade.compat.ts. No input hook or user fixture.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createServer as createProxy, createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { crc32, deflateSync } from 'node:zlib'

const repo = fileURLToPath(new URL('../../../', import.meta.url))
const hostRoot = process.env.ALUDOCK_TEST_HOST_ROOT || repo
const root = await mkdtemp(join(tmpdir(), 'am-'))
const home = join(root, 'home'), cwd = join(root, 'work'), agent = join(root, 'agent'), socket = join(root, 's'), proxySocket = join(root, 'p')
const env = { PATH: process.env.PATH, HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: agent, PI_OFFLINE: '1',
  XDG_CONFIG_HOME: join(root, 'config'), XDG_DATA_HOME: join(root, 'data'), XDG_CACHE_HOME: join(root, 'cache'),
  XDG_STATE_HOME: join(root, 'state'), XDG_RUNTIME_DIR: join(root, 'run'), APPDATA: join(root, 'appdata'), LOCALAPPDATA: join(root, 'localappdata'),
  npm_config_cache: join(root, 'npm-cache'), npm_config_userconfig: join(root, 'npmrc'), npm_config_globalconfig: join(root, 'global-npmrc'),
  TMPDIR: root, TMP: root, TEMP: root, NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' }
const providerName = 'attachment-loopback', model = 'attachment-image-model'
const requests = [], providerErrors = [], sockets = new Set()
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const counts = {}
let proxy
let host, reader, hostOutput = '', hostErrors = '', readerOutput = '', readerErrors = ''

// Tiny, valid RGB PNGs with genuinely different pixels, not padded payloads.
function png(rgb) {
  const chunk = (type, body) => {
    const data = Buffer.concat([Buffer.from(type), body]), length = Buffer.alloc(4), checksum = Buffer.alloc(4)
    length.writeUInt32BE(body.length); checksum.writeUInt32BE(crc32(data))
    return Buffer.concat([length, data, checksum])
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(2, 0); header.writeUInt32BE(2, 4); header[8] = 8; header[9] = 2
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.from([0, ...rgb, ...rgb, 0, ...rgb, ...rgb]))), chunk('IEND', Buffer.alloc(0))])
}
function sse(response, delta, finishReason = null) {
  response.write(`data: ${JSON.stringify({ id: 'attachment-fixture', object: 'chat.completion.chunk', created: 1, model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
    ...(finishReason ? { usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } } : {}) })}\n\n`)
}
const provider = createServer((request, response) => {
  void (async () => {
    assert.equal(request.socket.remoteAddress, '127.0.0.1')
    assert.equal(request.method, 'POST'); assert.equal(request.url, '/v1/chat/completions')
    assert.equal(request.headers.authorization, 'Bearer attachment-fixture-not-a-secret')
    const chunks = []; for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')); requests.push(body)
    assert.equal(body.model, model)
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    sse(response, { role: 'assistant', content: 'Local fixture received the photos.' })
    sse(response, {}, 'stop'); response.end('data: [DONE]\n\n')
  })().catch(error => { providerErrors.push(String(error)); response.destroy(error) })
})
provider.on('connection', connection => { sockets.add(connection); connection.on('close', () => sockets.delete(connection)) })
async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  child.kill('SIGTERM')
  await new Promise(resolve => {
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000)
    child.once('exit', () => { clearTimeout(timer); resolve() })
  })
}
try {
  assert.equal(process.platform, 'linux', 'this real local-transport gate requires Linux')
  await Promise.all([home, cwd, agent, join(root, 'sessions'), join(root, 'worker-home')].map(path => mkdir(path, { recursive: true })))
  await writeFile(join(root, 'npmrc'), ''); await writeFile(join(root, 'global-npmrc'), '')
  await writeFile(join(root, 'environment.json'), JSON.stringify(env, null, 2))
  const sources = []
  for (const [index, rgb] of [[235, 20, 35], [15, 180, 230]].entries()) {
    const path = join(root, `source-${index}.png`)
    await writeFile(path, png(rgb))
    const bytes = await readFile(path)
    sources.push({ path, sha256: sha(bytes), sizeBytes: bytes.length })
  }
  assert.notEqual(sources[0].sha256, sources[1].sha256)
  await writeFile(join(root, 'sources.json'), JSON.stringify(sources, null, 2))
  await new Promise((resolve, reject) => { provider.once('error', reject); provider.listen(0, '127.0.0.1', resolve) })
  const baseUrl = `http://127.0.0.1:${provider.address().port}/v1`
  await writeFile(join(agent, 'models.json'), JSON.stringify({ providers: { [providerName]: {
    baseUrl, api: 'openai-completions', apiKey: 'attachment-fixture-not-a-secret',
    models: [{ id: model, name: 'Local attachment fixture', reasoning: false, input: ['text', 'image'],
      contextWindow: 32000, maxTokens: 2000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
  } } }))
  await writeFile(join(agent, 'settings.json'), JSON.stringify({ defaultProvider: providerName, defaultModel: model, retry: { enabled: false } }))
  // JS only prepares the isolated Host/Work. Every upload, submit, follow, image,
  // history and reload below is performed by the formal public Rust client.
  const script = `
    import { DockHost } from './dist/src/control/dock-host.js';
    import { DockClient } from './dist/src/control/dock-client.js';
    import { DockRegistry } from './dist/src/control/dock-registry.js';
    import { MainMachineState } from './dist/src/control/machine-state.js';
    import { MachineSettingsState } from './dist/src/control/machine-settings-state.js';
    import { MainMachineController } from './dist/src/control/machine-transport.js';
    import { AttachmentService } from './dist/src/control/attachment-service.js';
    import { AttachmentStorageState } from './dist/src/control/attachment-storage-state.js';
    import { createPiInstance, resolvePiReopenTarget } from './dist/src/pi/create-pi-instance.js';
    const workerPids = [];
    const workerEnvironment = {...process.env, HOME:${JSON.stringify(join(root, 'worker-home'))}, USERPROFILE:${JSON.stringify(join(root, 'worker-home'))}};
    const attachmentService = new AttachmentService(new AttachmentStorageState(${JSON.stringify(join(root, 'state'))}, ${JSON.stringify(join(root, 'attachments'))}));
    const registry = new DockRegistry(input => createPiInstance({...input, agentDir:${JSON.stringify(agent)}, sessionDir:${JSON.stringify(join(root, 'sessions'))}, workerEnvironment, onWorkerSpawn:pid => workerPids.push(pid)}), undefined, {attachmentHostPort:attachmentService, reopenTargetResolver:{resolve:resolvePiReopenTarget}});
    const remoteInstances = new MainMachineController({
      state: new MainMachineState(${JSON.stringify(join(root, 'main-state'))}, 'Isolated media Main'),
      settingsState: new MachineSettingsState(${JSON.stringify(join(root, 'machine-settings'))}),
      mainHostEpoch: registry.hostEpoch, localSnapshots: () => registry.list(),
    });
    const host = new DockHost({remoteInstances, socketPath:${JSON.stringify(socket)}, registry, attachmentService});
    const client = new DockClient({socketPath:host.socketPath});
    process.on('SIGTERM', async () => {client.closeActiveConnections(); await host.stop(); process.exit(0)});
    await host.start();
    const instance = await client.create(${JSON.stringify(cwd)}, 'Attachment media gate', 'attachment-create');
    console.log(JSON.stringify({kind:'ready', id:instance.id, model:instance.executor.model, hostPid:process.pid, workerPids}));
  `
  await writeFile(join(root, 'host-script.txt'), script)
  host = spawn(process.execPath, ['--input-type=module', '-e', script], { cwd: hostRoot, env, stdio: ['ignore', 'pipe', 'pipe'] })
  host.stdout.on('data', b => { hostOutput += b }); host.stderr.on('data', b => { hostErrors += b })
  const lines = createInterface({ input: host.stdout })
  const ready = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Host timeout: ${hostErrors}`)), 30000)
    lines.on('line', line => {
      let data; try { data = JSON.parse(line) } catch { return }
      if (data.kind === 'ready') { clearTimeout(timer); resolve(data) }
    })
    host.once('exit', code => { clearTimeout(timer); reject(new Error(`Host exit ${code}: ${hostErrors}`)) })
    host.once('error', error => { clearTimeout(timer); reject(error) })
  })
  assert.deepEqual(ready.model, { provider: providerName, id: model })
  assert.equal(ready.workerPids.length, 1); assert.notEqual(ready.workerPids[0], ready.hostPid)
  process.kill(ready.workerPids[0], 0)
  await writeFile(join(root, 'ready.json'), JSON.stringify(ready, null, 2))
  // Observe requests without changing any Host/Worker DTO or response. The
  // selected original must not be fetched again via image/content transport.
  proxy = createProxy(incoming => {
    const outgoing = createConnection(socket); sockets.add(incoming); sockets.add(outgoing)
    let buffered = ''
    incoming.on('data', bytes => {
      buffered += bytes
      for (;;) {
        const end = buffered.indexOf('\n'); if (end < 0) break
        const line = buffered.slice(0, end); buffered = buffered.slice(end + 1)
        const frame = JSON.parse(line)
        if (frame.kind === 'request') counts[frame.type] = (counts[frame.type] || 0) + 1
        outgoing.write(line + '\n')
      }
    })
    outgoing.pipe(incoming)
    incoming.on('error', () => outgoing.destroy()); outgoing.on('error', () => incoming.destroy())
    incoming.on('end', () => outgoing.end())
    incoming.on('close', () => { sockets.delete(incoming); outgoing.destroy() }); outgoing.on('close', () => sockets.delete(outgoing))
  })
  await new Promise((resolve, reject) => { proxy.once('error', reject); proxy.listen(proxySocket, resolve) })
  reader = spawn(process.env.ALUDOCK_ATTACHMENT_READER || join(repo, 'clients/official/target/debug/examples/protocol_attachment_media'),
    [proxySocket, join(root, 'identity'), ready.id, join(root, 'sources.json'), root], { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'] })
  reader.stdout.on('data', b => { readerOutput += b }); reader.stderr.on('data', b => { readerErrors += b })
  const code = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { void stop(reader); reject(new Error('Rust attachment gate timeout')) }, 90000)
    reader.once('exit', code => { clearTimeout(timer); resolve(code) })
    reader.once('error', error => { clearTimeout(timer); reject(error) })
  })
  assert.equal(code, 0, `${readerErrors}\nHost: ${hostErrors}`)
  assert.deepEqual(providerErrors, [])
  const result = JSON.parse(readerOutput.trim()); assert.equal(result.kind, 'attachment-media.pass')
  assert.equal(result.turns.length, 2)
  assert.equal(counts['conversation.image'] || 0, 0, 'receipt-backed live/history/reload uses the private original, not an image download')
  assert.equal(counts['conversation.content'] || 0, 0, 'the standard image.fileId does not require body hydration')
  // This is supporting vision-input evidence, not a substitute for Rust's live
  // and persisted record assertions. Expectations are independent source bytes.
  const providerImages = requests.map(body => {
    const user = body.messages.findLast(message => message.role === 'user')
    return user.content.filter(block => block.type === 'image_url').map(block => {
      assert.ok(block.image_url.url.startsWith('data:image/png;base64,'))
      return sha(Buffer.from(block.image_url.url.split(',')[1], 'base64'))
    })
  })
  assert.deepEqual(providerImages, [[sources[0].sha256], [sources[1].sha256, sources[0].sha256]])
  await writeFile(join(root, 'result.json'), JSON.stringify({ ...result, counts, root, hostRoot, ...ready, kind: result.kind, providerImages }, null, 2))
  console.log(JSON.stringify({ kind: result.kind, counts, root, hostRoot, workerPids: ready.workerPids, sources, providerImages }))
} finally {
  await stop(reader); await stop(host)
  for (const connection of sockets) connection.destroy()
  if (proxy) await new Promise(resolve => proxy.close(resolve))
  if (provider.listening) await new Promise(resolve => provider.close(resolve))
  await Promise.all([
    writeFile(join(root, 'host.stdout'), hostOutput), writeFile(join(root, 'host.stderr'), hostErrors),
    writeFile(join(root, 'reader.stdout'), readerOutput), writeFile(join(root, 'reader.stderr'), readerErrors),
    writeFile(join(root, 'provider-requests.json'), JSON.stringify(requests, null, 2)),
    writeFile(join(root, 'provider-errors.json'), JSON.stringify(providerErrors, null, 2)),
  ])
  if (process.env.ALUDOCK_ATTACHMENT_KEEP === '1') console.error(`Attachment media evidence: ${root}`)
  else await rm(root, { recursive: true, force: true })
}
