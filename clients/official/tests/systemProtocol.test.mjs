// Explicit integration gate: build the protocol_system Rust example and root TS first.
// Real Host/Worker APIs with the existing isolated workerEnvironment seam; not a CLI/login-shell gate.
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'

const repo = fileURLToPath(new URL('../../../', import.meta.url))
const root = await mkdtemp(join(tmpdir(), 'alu-official-system-'))
const home = join(root, 'home'), cwd = join(root, 'workspace'), agent = join(root, 'agent')
const systems = join(home, '.aludock', 'systems'), socket = join(root, 'dock.sock')
const env = { PATH: process.env.PATH, HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: agent, PI_OFFLINE: '1',
  XDG_CONFIG_HOME: join(root, 'config'), XDG_DATA_HOME: join(root, 'data'), XDG_CACHE_HOME: join(root, 'cache'),
  XDG_STATE_HOME: join(root, 'state'), XDG_RUNTIME_DIR: join(root, 'run'),
  APPDATA: join(root, 'appdata'), LOCALAPPDATA: join(root, 'localappdata'), TMPDIR: root, TEMP: root, TMP: root }
let host, reader
async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  child.kill('SIGTERM')
  await new Promise(resolve => {
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000)
    child.once('exit', () => { clearTimeout(timer); resolve() })
  })
}
try {
  assert.equal(process.platform, 'linux', 'This isolated gate uses Linux Unix sockets')
  await Promise.all([mkdir(systems, { recursive: true }), mkdir(join(cwd, '.pi', 'extensions'), { recursive: true }), mkdir(agent), mkdir(join(root, 'worker-home')), mkdir(join(root, 'state'))])
  await writeFile(join(cwd, '.pi', 'SYSTEM.md'), '# Project system should not override the active choice\n')
  await writeFile(join(cwd, '.pi', 'extensions', 'trust.ts'), 'export default function () {}\n')
  const body = '\uFEFF' + JSON.stringify({ intro: 'RUST HOST SYSTEM ' + '中文原文 '.repeat(24000), toolNotes: '', guidelines: [], documentationHeading: '', documentationInstructions: [] }) + '\n'
  await writeFile(join(systems, 'chosen.json'), body)
  await writeFile(join(agent, 'settings.json'), JSON.stringify({ defaultProvider: 'openai', defaultModel: 'gpt-4o-mini' }))
  // Deliberately no auth.json and no command that sends a model prompt.
  const hostScript = `
    import { DockHost } from './dist/src/control/dock-host.js';
    import { DockRegistry } from './dist/src/control/dock-registry.js';
    import { SystemService } from './dist/src/control/system-service.js';
    import { MainMachineState } from './dist/src/control/machine-state.js';
    import { MachineSettingsState } from './dist/src/control/machine-settings-state.js';
    import { MainMachineController } from './dist/src/control/machine-transport.js';
    import { createPiSystemTemplateProvider } from './dist/src/pi/system-template-provider.js';
    import { createPiInstance, createPiProjectTrustCoordinator } from './dist/src/pi/create-pi-instance.js';
    const agentDir = ${JSON.stringify(agent)};
    const workerEnvironment = { ...process.env, HOME: ${JSON.stringify(join(root, 'worker-home'))}, USERPROFILE: ${JSON.stringify(join(root, 'worker-home'))} };
    const registry = new DockRegistry(input => createPiInstance({ ...input, agentDir, workerEnvironment }), undefined,
      { trustPreflight: createPiProjectTrustCoordinator(agentDir), systemService: new SystemService(${JSON.stringify(home)}, createPiSystemTemplateProvider(agentDir)) });
    const remoteInstances = new MainMachineController({
      state: new MainMachineState(${JSON.stringify(join(root, 'main-state'))}, 'Isolated Main'),
      settingsState: new MachineSettingsState(${JSON.stringify(join(root, 'machine-settings'))}),
      mainHostEpoch: registry.hostEpoch, localSnapshots: () => registry.list(),
    });
    const host = new DockHost({ remoteInstances, socketPath: ${JSON.stringify(socket)}, registry });
    await host.start();
    process.on('SIGTERM', async () => { await host.stop(); process.exit(0); });
    console.log(JSON.stringify({ kind: 'host.ready' }));
  `
  host = spawn(process.execPath, ['--input-type=module', '-e', hostScript], { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let hostErrors = ''
  host.stderr.on('data', chunk => { hostErrors += chunk })
  const lines = createInterface({ input: host.stdout })
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Host startup timeout: ${hostErrors}`)), 15000)
    const finish = callback => value => { clearTimeout(timer); callback(value) }
    lines.on('line', line => { try { if (JSON.parse(line).kind === 'host.ready') finish(resolve)() } catch {} })
    host.once('error', finish(reject))
    host.once('exit', finish(() => reject(new Error(`Host exited: ${hostErrors}`))))
  })
  lines.close()
  reader = spawn(join(repo, 'clients/official/target/debug/examples/protocol_system'), [socket, join(root, 'identity'), cwd], { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = '', stderr = ''
  reader.stdout.on('data', chunk => { stdout += chunk })
  reader.stderr.on('data', chunk => { stderr += chunk })
  const code = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { void stop(reader); reject(new Error('Rust gate timeout')) }, 45000)
    reader.once('error', error => { clearTimeout(timer); reject(error) })
    reader.once('exit', code => { clearTimeout(timer); resolve(code) })
  })
  assert.equal(code, 0, `Rust gate failed:\n${stderr}\nHost:\n${hostErrors}`)
  assert.match(stdout, /PASS Rust/)
  assert.deepEqual(Object.keys(JSON.parse(await readFile(join(cwd, '.aludock', 'system-default.json'), 'utf8'))), ['id'])
  assert.equal(await readFile(join(systems, 'chosen.json'), 'utf8'), body)
  console.log(stdout.trim())
} finally {
  await stop(reader)
  await stop(host)
  await rm(root, { recursive: true, force: true })
}
