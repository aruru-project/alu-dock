// One real core→Host→Worker media gate. ALUDOCK_TEST_HOST_ROOT can select the
// frozen pre-D dist. No model calls, CLI login shell, production paths or credentials.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { Transform } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { crc32, deflateSync } from 'node:zlib'

const repo = fileURLToPath(new URL('../../../', import.meta.url))
const hostRoot = process.env.ALUDOCK_TEST_HOST_ROOT || repo
const root = await mkdtemp(join(tmpdir(), 'alu-media-protocol-'))
const home = join(root, 'home'), cwd = join(root, 'workspace'), agent = join(root, 'agent'), socket = join(root, 'host.sock'), proxySocket = join(root, 'reader.sock')
const env = { PATH: process.env.PATH, HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: agent, PI_OFFLINE: '1',
  XDG_CONFIG_HOME: join(root, 'config'), XDG_DATA_HOME: join(root, 'data'), XDG_CACHE_HOME: join(root, 'cache'),
  XDG_STATE_HOME: join(root, 'state'), XDG_RUNTIME_DIR: join(root, 'run'), APPDATA: join(root, 'appdata'), LOCALAPPDATA: join(root, 'localappdata'),
  npm_config_cache: join(root, 'npm-cache'), npm_config_userconfig: join(root, 'npmrc'), npm_config_globalconfig: join(root, 'global-npmrc'), TMPDIR: root, TMP: root, TEMP: root }
const counts = {}, wireBytes = {}, sockets = new Set()
const fault = process.env.ALUDOCK_MEDIA_FAULT || 'none'
let corruptOnce = fault !== 'none'
let host, reader, proxy
let hostErrors = '', hostOutput = ''
async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  child.kill('SIGTERM')
  await new Promise(resolve => { const timer = setTimeout(() => child.kill('SIGKILL'), 5000); child.once('exit', () => { clearTimeout(timer); resolve() }) })
}
function png() {
  // Actual 2048² pixels, not a tiny PNG padded with unrelated payload. Decoding
  // still belongs to the WebView gate; this test reports no decode measurement.
  const width = 2048, height = 2048, raw = Buffer.alloc(height * (width * 3 + 1)); let seed = 7
  for (let y = 0; y < height; y++) for (let x = 1; x <= (process.env.ALUDOCK_MEDIA_ENTROPY === 'full' ? width * 3 : 256); x++) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; raw[y * (width * 3 + 1) + x] = seed >>> 24 }
  const chunk = (type, body) => { const b = Buffer.concat([Buffer.from(type), body]), n = Buffer.alloc(4), c = Buffer.alloc(4); n.writeUInt32BE(body.length); c.writeUInt32BE(crc32(b)); return Buffer.concat([n, b, c]) }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}
try {
  assert.equal(process.platform, 'linux')
  assert.ok(['none', 'sha'].includes(fault), 'this gate exercises only the image stream')
  await Promise.all([home, cwd, agent, join(root, 'worker-home'), join(root, 'state')].map(path => mkdir(path, { recursive: true })))
  await writeFile(join(root, 'npmrc'), ''); await writeFile(join(root, 'global-npmrc'), '')
  const image = png(), sha = createHash('sha256').update(image).digest('hex')
  await writeFile(join(root, 'source.png'), image)
  await writeFile(join(root, 'environment.json'), JSON.stringify(env, null, 2))
  await writeFile(join(agent, 'settings.json'), JSON.stringify({ defaultProvider: 'openai', defaultModel: 'gpt-4o-mini' }))
  const script = `
    import { readFile } from 'node:fs/promises';
    import { SessionManager } from '@earendil-works/pi-coding-agent';
    import { DockHost } from './dist/src/control/dock-host.js';
    import { DockClient } from './dist/src/control/dock-client.js';
    import { DockRegistry } from './dist/src/control/dock-registry.js';
    import { createPiInstance, resolvePiReopenTarget } from './dist/src/pi/create-pi-instance.js';
    const manager = SessionManager.create(${JSON.stringify(cwd)}, ${JSON.stringify(join(root, 'sessions'))});
    manager.appendMessage({ role:'user', content:[{type:'text',text:'Local source image'}, {type:'image',mimeType:'image/png',data:(await readFile(${JSON.stringify(join(root, 'source.png'))})).toString('base64')}],timestamp:1 });
    manager.appendMessage({role:'assistant',content:[{type:'text',text:'Saved offline answer'}],api:'openai-completions',provider:'openai',model:'gpt-4o-mini',stopReason:'stop',timestamp:2,usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}});
    const workerEnvironment = {...process.env, HOME:${JSON.stringify(join(root, 'worker-home'))}, USERPROFILE:${JSON.stringify(join(root, 'worker-home'))}};
    const registry = new DockRegistry(input => createPiInstance({...input, agentDir:${JSON.stringify(agent)}, workerEnvironment}), undefined, {reopenTargetResolver:{resolve:resolvePiReopenTarget}});
    const host = new DockHost({socketPath:${JSON.stringify(socket)}, registry}); await host.start();
    const client = new DockClient({socketPath:host.socketPath});
    const result = await client.adopt(manager.getSessionFile());
    process.on('SIGTERM', async () => {client.closeActiveConnections(); await host.stop(); process.exit(0)});
    console.log(JSON.stringify({kind:'ready',id:result.instance.id}));
  `
  await writeFile(join(root, 'host-script.txt'), script)
  host = spawn(process.execPath, ['--input-type=module', '-e', script], { cwd: hostRoot, env, stdio: ['pipe', 'pipe', 'pipe'] })
  host.stdout.on('data', b => { hostOutput += b })
  host.stderr.on('data', b => { hostErrors += b })
  const lines = createInterface({ input: host.stdout })
  const workId = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Host timeout: ${hostErrors}`)), 30000)
    lines.on('line', line => { try { const data = JSON.parse(line); if (data.kind === 'ready') { clearTimeout(timer); resolve(data.id) } } catch {} })
    host.once('exit', code => { clearTimeout(timer); reject(new Error(`Host exit ${code}: ${hostErrors}`)) })
    host.once('error', reject)
  })
  proxy = createServer(socketIn => {
    const out = createConnection(socket); sockets.add(socketIn); sockets.add(out)
    let incoming = '', method = 'hello'
    socketIn.on('data', bytes => { incoming += bytes; for (;;) { const end = incoming.indexOf('\n'); if (end < 0) break; const line = incoming.slice(0, end); incoming = incoming.slice(end + 1); const frame = JSON.parse(line); if (frame.kind === 'request') { method = frame.type; counts[method] = (counts[method] || 0) + 1 }
      out.write(line + '\n')
    } })
    out.on('data', b => { wireBytes[method] = (wireBytes[method] || 0) + b.length })
    socketIn.on('error', () => out.destroy()); out.on('error', () => socketIn.destroy())
    socketIn.on('close', () => sockets.delete(socketIn)); out.on('close', () => sockets.delete(out))
    socketIn.on('end', () => out.end())
    if (fault === 'sha') {
      let buffered = ''
      out.pipe(new Transform({ transform(bytes, _encoding, done) {
        buffered += bytes
        for (;;) {
          const end = buffered.indexOf('\n'); if (end < 0) break
          let line = buffered.slice(0, end); buffered = buffered.slice(end + 1)
          if (fault === 'sha' && corruptOnce && method === 'conversation.image' && line.includes('conversation_image_complete')) {
            const frame = JSON.parse(line); frame.sha256 = '0'.repeat(64); line = JSON.stringify(frame); corruptOnce = false
          }
          this.push(line + '\n')
        }
        done()
      } })).pipe(socketIn)
    } else out.pipe(socketIn)
  })
  await new Promise((resolve, reject) => { proxy.once('error', reject); proxy.listen(proxySocket, resolve) })
  reader = spawn(process.env.ALUDOCK_MEDIA_READER || join(repo, 'clients/official/target/debug/examples/protocol_media'), [proxySocket, join(root, 'identity'), workId, join(root, 'content'), sha, process.env.ALUDOCK_MEDIA_FAULT || 'none'], { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = '', stderr = ''; reader.stdout.on('data', b => { stdout += b }); reader.stderr.on('data', b => { stderr += b })
  const code = await new Promise((resolve, reject) => { const timer = setTimeout(() => { void stop(reader); reject(new Error('Rust media timeout')) }, 60000); reader.once('exit', c => { clearTimeout(timer); resolve(c) }); reader.once('error', reject) })
  await writeFile(join(root, 'reader.stdout'), stdout); await writeFile(join(root, 'reader.stderr'), stderr)
  assert.equal(code, 0, `${stderr}\nHost: ${hostErrors}`)
  const measurement = JSON.parse(stdout.trim()); assert.equal(measurement.kind, 'media.pass'); assert.equal(measurement.sizeBytes, image.length)
  assert.equal(counts['conversation.image'], fault === 'sha' ? 2 : 1, 'a rejected partial is retried once; concurrent successful callers and later rebinding share the verified file')
  assert.equal(counts['conversation.content'] || 0, 0, 'an available image descriptor is independent of body hydration')
  const result = { root, hostRoot, fault: process.env.ALUDOCK_MEDIA_FAULT || 'none', entropy: process.env.ALUDOCK_MEDIA_ENTROPY || 'normal', ...measurement, pixelWidth: 2048, pixelHeight: 2048, decodedRgbaBytes: 16777216, counts, wireBytes }
  await writeFile(join(root, 'result.json'), JSON.stringify(result, null, 2))
  console.log(JSON.stringify(result))
} finally {
  await stop(reader); for (const socket of sockets) socket.destroy()
  if (proxy) await new Promise(resolve => proxy.close(resolve))
  await stop(host)
  await writeFile(join(root, 'host.stdout'), hostOutput); await writeFile(join(root, 'host.stderr'), hostErrors)
  if (process.env.ALUDOCK_MEDIA_KEEP !== '1') await rm(root, { recursive: true, force: true })
  else console.error(`Media evidence: ${root}`)
}
