// Actual Rust public API → isolated Host/Worker. Saved data and a no-turn extension; no model.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { crc32 } from 'node:zlib'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createServer, createConnection } from 'node:net'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

const repo = fileURLToPath(new URL('../../../', import.meta.url))
const hostRoot = process.env.ALUDOCK_TEST_HOST_ROOT || repo
const legacy = process.argv.includes('--legacy')
const root = await mkdtemp(join(tmpdir(), 'alu-content-protocol-'))
const home = join(root, 'home'), cwd = join(root, 'workspace'), agent = join(root, 'agent'), socket = join(root, 'host.sock')
const env = { PATH: process.env.PATH, HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: agent, PI_OFFLINE: '1',
  XDG_CONFIG_HOME: join(root, 'config'), XDG_DATA_HOME: join(root, 'data'), XDG_CACHE_HOME: join(root, 'cache'),
  XDG_STATE_HOME: join(root, 'state'), XDG_RUNTIME_DIR: join(root, 'run'), APPDATA: join(root, 'appdata'), LOCALAPPDATA: join(root, 'localappdata'),
  npm_config_cache: join(root, 'npm-cache'), npm_config_userconfig: join(root, 'npmrc'), npm_config_globalconfig: join(root, 'global-npmrc'), TMPDIR: root, TMP: root, TEMP: root }
let host, reader, proxy
let blockContent = false, offlineSeen = false, onlineSeen = false, offlineRequests
const sockets = new Set(), counts = {}, errors = {}
let shortReference, referenceChunks = 0, shortBodyReads = 0
let heldContent, heldFast, heldEarlier, earlierWaiterDropped = false, appended = false, slowReference, fastReference, fastBodySeen = false, fastWhileHeld = false, slowHeld = false
const appendWhenFast = () => { if (slowHeld && fastBodySeen && !appended) host.stdin.write('append\n') }
async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  child.kill('SIGTERM')
  await new Promise(resolve => { const timer = setTimeout(() => child.kill('SIGKILL'), 5000); child.once('exit', () => { clearTimeout(timer); resolve() }) })
}
try {
  assert.equal(process.platform, 'linux')
  await Promise.all([home, cwd, agent, join(root, 'worker-home'), join(root, 'state')].map(path => mkdir(path, { recursive: true })))
  await writeFile(join(root, 'npmrc'), ''); await writeFile(join(root, 'global-npmrc'), '')
  await writeFile(join(agent, 'settings.json'), JSON.stringify({ defaultProvider: 'openai', defaultModel: 'gpt-4o-mini' }))
  await mkdir(join(agent, 'extensions'), { recursive: true })
  await writeFile(join(agent, 'extensions/content-append.ts'), `export default function(pi) {
    pi.registerCommand("content-append", { handler: async () => { pi.sendMessage({customType:"content-append",content:"Appended during body read",display:true},{triggerTurn:false}); } });
    pi.on("input", () => ({action:"handled"}));
  }`)

  // #325: real Pi JSONL keeps a valid 2 MiB PNG, while mixed body reads use references.
  const base = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64')
  const payload = Buffer.alloc(2 * 1024 * 1024 - base.length - 12, 120); payload.write('Diagnostic\0')
  const chunk = Buffer.concat([Buffer.from('tEXt'), payload]), length = Buffer.alloc(4), crc = Buffer.alloc(4)
  length.writeUInt32BE(payload.length); crc.writeUInt32BE(crc32(chunk))
  const png = Buffer.concat([base.subarray(0, 33), length, chunk, crc, base.subarray(33)])
  const imagePath = join(root, 'source.png'); await writeFile(imagePath, png)
  const imageSha = createHash('sha256').update(png).digest('hex')
  const script = `
    import { readFile } from 'node:fs/promises';
    const image = {type:'image',mimeType:'image/png',data:(await readFile(${JSON.stringify(imagePath)})).toString('base64')};
    import { SessionManager } from '@earendil-works/pi-coding-agent';
    import { DockHost } from './dist/src/control/dock-host.js';
    import { DockClient } from './dist/src/control/dock-client.js';
    import { DockRegistry } from './dist/src/control/dock-registry.js';
    import { createPiInstance, resolvePiReopenTarget } from './dist/src/pi/create-pi-instance.js';
    const manager = SessionManager.create(${JSON.stringify(cwd)}, ${JSON.stringify(join(root, 'sessions'))});
    manager.appendMessage({role:'user',content:[{type:'text',text:'Use the saved tool group'}],timestamp:0});
    manager.appendMessage({role:'assistant',content:Array.from({length:55},(_,i)=>({type:'toolCall',id:'tool-'+i,name:'read',arguments:{path:'saved-'+i}})),api:'openai-completions',provider:'openai',model:'gpt-4o-mini',stopReason:'toolUse',timestamp:1,usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}});
    for(let i=0;i<55;i++) manager.appendMessage({role:'toolResult',toolCallId:'tool-'+i,toolName:'read',content:[{type:'text',text:'saved output '+i}],isError:false,timestamp:2});
    for(let i=1;i<=260;i++) manager.appendMessage(i % 2 ? { role:'user', content:[{type:'text',text:i===250 ? 'history-250 '+ 'x'.repeat(150000) : i===240 ? 'fast-body '+ 'y'.repeat(40000) : 'history-'+i}, ...(i===239 ? [image,{type:'text',text:'short-after-image'}] : [])],timestamp:i } : {role:'assistant',content:[{type:'text',text:i===250 ? 'history-250 '+ 'x'.repeat(150000) : i===240 ? 'fast-body '+ 'y'.repeat(40000) : 'history-'+i}, ...(i===250 ? [image,{type:'text',text:'long-after-image'}] : [])],api:'openai-completions',provider:'openai',model:'gpt-4o-mini',stopReason:'stop',timestamp:i,usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}});
    const workerEnvironment = {...process.env, HOME:${JSON.stringify(join(root, 'worker-home'))}, USERPROFILE:${JSON.stringify(join(root, 'worker-home'))}};
    const registry = new DockRegistry(input => createPiInstance({...input, agentDir:${JSON.stringify(agent)}, workerEnvironment}), undefined, {reopenTargetResolver:{resolve:resolvePiReopenTarget}});
    const host = new DockHost({socketPath:${JSON.stringify(socket)}, registry}); await host.start();
    const client = new DockClient({socketPath:host.socketPath});
    const result = await client.adopt(manager.getSessionFile());
    const other = SessionManager.create(${JSON.stringify(cwd)}, ${JSON.stringify(join(root, 'sessions'))});
    other.appendMessage({role:'user',content:[{type:'text',text:'Other Work'}],timestamp:1});
    other.appendMessage({role:'assistant',content:[{type:'text',text:'Other saved answer'}],api:'openai-completions',provider:'openai',model:'gpt-4o-mini',stopReason:'stop',timestamp:2,usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}});
    const otherResult = await client.adopt(other.getSessionFile());

    process.stdin.setEncoding('utf8'); process.stdin.on('data', async command => { if(command.trim()==='append') { const commands = await client.commands(result.instance.id); if(!commands.commands.some(command => command.name==='content-append')) throw new Error('isolated append extension unavailable'); await client.prompt(result.instance.id, '/content-append'); console.log(JSON.stringify({kind:'appended'})); } });
    process.on('SIGTERM', async () => {client.closeActiveConnections(); await host.stop(); process.exit(0)});
    console.log(JSON.stringify({kind:'ready',id:result.instance.id,otherId:otherResult.instance.id,sessionFile:manager.getSessionFile()}));
  `
  host = spawn(process.execPath, ['--input-type=module', '-e', script], { cwd: hostRoot, env, stdio: ['pipe', 'pipe', 'pipe'] })
  let hostErrors = ''; host.stderr.on('data', b => { hostErrors += b })
  const lines = createInterface({ input: host.stdout })
  const target = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Host timeout: ${hostErrors}`)), 30000)
    lines.on('line', line => { try { const data = JSON.parse(line); if (data.kind === 'ready') { clearTimeout(timer); resolve(data) } } catch {} })
    host.once('exit', code => { clearTimeout(timer); reject(new Error(`Host exit ${code}: ${hostErrors}`)) }); host.once('error', reject)
  })
  const originalSession = await readFile(target.sessionFile)
  lines.on('line', line => { try { if (JSON.parse(line).kind === 'appended') { appended = true; heldContent?.(); heldContent = null } } catch {} })
  const proxySocket = join(root, 'reader.sock')
  let appendStarted = false
  proxy = createServer(incoming => {
    const outgoing = createConnection(socket); sockets.add(incoming); sockets.add(outgoing)
    let buffer = '', response = '', method = ''
    incoming.on('data', bytes => {
      buffer += bytes
      for (;;) {
        const end = buffer.indexOf('\n'); if (end < 0) break
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1)
        const frame = JSON.parse(line)
        if (frame.kind === 'request') { method = frame.type; counts[method] = (counts[method] || 0) + 1; if (method === 'conversation.content' && frame.params.contentRef === shortReference) shortBodyReads++ }
        if (frame.kind === 'request' && blockContent) { incoming.destroy(); outgoing.destroy(); continue }
        if (frame.kind === 'request' && method === 'session.history' && !earlierWaiterDropped) {
          heldEarlier = () => outgoing.write(line + '\n')
        } else if (frame.kind === 'request' && method === 'conversation.content' && frame.params.contentRef === fastReference && !slowHeld) {
          heldFast = () => outgoing.write(line + '\n')
        } else if (frame.kind === 'request' && method === 'conversation.content' && frame.params.contentRef === slowReference && frame.params.cursor && !appendStarted) {
          appendStarted = true
          // A registered no-turn extension appends in the isolated Worker. Hold
          // a real body continuation until that public mutation completes.
          heldContent = () => outgoing.write(line + '\n')
          slowHeld = true; heldFast?.(); heldFast = null; appendWhenFast()
        } else outgoing.write(line + '\n')
      }
    })
    outgoing.on('data', bytes => {
      incoming.write(bytes); response += bytes
      for (;;) {
        const end = response.indexOf('\n'); if (end < 0) break
        const line = response.slice(0, end); response = response.slice(end + 1)
        const frame = JSON.parse(line)
        if (frame.error?.code) errors[frame.error.code] = (errors[frame.error.code] || 0) + 1
        if (method === 'conversation.content') for (const chunk of frame.result?.chunks ?? []) {
          if (!legacy) assert.equal('data' in chunk, false, '#325 mixed reference body must not transfer image bytes')
          if (chunk.type === 'image_ref') referenceChunks++
        }
        if (method === 'conversation.history') for (const item of frame.result?.entries ?? []) {
          if (item.entry.content.some(block => block.type === 'text' && block.text.startsWith('history-250 '))) slowReference = item.contentRef
          if (item.entry.content.some(block => block.type === 'text' && block.text.startsWith('fast-body '))) fastReference = item.contentRef
          if (item.entry.content.some(block => block.type === 'text' && block.text === 'history-239')) { shortReference = item.contentRef; assert.equal(item.contentComplete, !legacy) }
        }
      }
    })
    incoming.on('error', () => outgoing.destroy()); outgoing.on('error', () => incoming.destroy())
    incoming.on('end', () => outgoing.end()); outgoing.on('end', () => incoming.end())
    incoming.on('close', () => { sockets.delete(incoming); outgoing.destroy() }); outgoing.on('close', () => { sockets.delete(outgoing) })
  })
  await new Promise((resolve, reject) => { proxy.once('error', reject); proxy.listen(proxySocket, resolve) })
  reader = spawn(join(repo, 'clients/official/target/debug/examples/protocol_content'), [proxySocket, join(root, 'identity'), target.id, join(root, 'content'), target.otherId, imageSha], { cwd: repo, env, stdio: ['pipe', 'pipe', 'pipe'] })
  let stdout = '', stderr = ''; reader.stdout.on('data', b => { stdout += b; if (!offlineSeen && stdout.includes('cache-offline')) { offlineSeen = true; offlineRequests = { ...counts }; blockContent = true; reader.stdin.write('continue\n') } if (!onlineSeen && stdout.includes('cache-online')) { onlineSeen = true; assert.deepEqual(counts, offlineRequests, 'offline rebinding reads native content, not Host'); blockContent = false; reader.stdin.write('continue\n') } if (!earlierWaiterDropped && stdout.includes('earlier-waiter-dropped')) { earlierWaiterDropped = true; heldEarlier?.(); heldEarlier = null } if (!fastBodySeen && stdout.includes('fast-body.pass')) { fastBodySeen = true; fastWhileHeld = slowHeld && !appended; appendWhenFast() } }); reader.stderr.on('data', b => { stderr += b })
  const code = await new Promise((resolve, reject) => { const timer = setTimeout(() => { void stop(reader); reject(new Error('Rust content timeout')) }, 60000); reader.once('exit', c => { clearTimeout(timer); resolve(c) }); reader.once('error', reject) })
  assert.equal(code, 0, `${stderr}\nHost: ${hostErrors}\n${JSON.stringify({ counts, errors, appended })}`)
  const evidence = JSON.parse(stdout.trim().split('\n').at(-1)); assert.equal(evidence.kind, 'content.pass')
  assert.equal(offlineSeen && onlineSeen, true, 'cached Work rebinding completed with the Host blocked')
  assert.equal(earlierWaiterDropped, true, 'the view waiter was dropped while the native history request remained owned')
  assert.equal(fastWhileHeld, true, 'another full body completed while the slow continuation was actually held')
  assert.equal(appended, true, 'a real Worker append occurred while an old descriptor body was queued')
  assert.ok((await readFile(target.sessionFile)).subarray(0, originalSession.length).equals(originalSession), 'reference reads do not rewrite the original Pi JSONL, including image data')
  assert.ok(shortReference)
  if (legacy) { assert.ok(shortBodyReads > 0); assert.equal(referenceChunks, 0); assert.equal(errors.capability_missing, 2, 'one probe for the body descriptor scan and one for the later independent history scan; none per content page') }
  else { assert.equal(shortBodyReads, 0); assert.ok(referenceChunks > 0); assert.equal(counts['conversation.image'], 1, 'the original PNG uses the independent media owner') }
  console.log(JSON.stringify({ hostRoot, ...evidence, earlierWaiterDropped, fastWhileHeld, appended, counts, errors, referenceChunks, shortBodyReads }))
} finally {
  await stop(reader); for (const socket of sockets) socket.destroy(); if (proxy) await new Promise(resolve => proxy.close(resolve)); await stop(host); await rm(root, { recursive: true, force: true })
}
