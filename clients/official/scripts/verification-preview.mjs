import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { createServer, resolveConfig } from 'vite'

const root = fileURLToPath(new URL('../', import.meta.url))
const configFile = join(root, 'vite.config.ts')

// Verification previews a fixed source state, not another hot-reload setup.
// 2026-09-10/19/28: independent Vite servers watched Rust output and exhausted
// file watchers. Always load the project config and disable watching before start.
export async function startVerificationPreview({ port = 1422, fixtureFile } = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error('预览端口无效，请使用 0 到 65535 之间的整数。')
  }
  const fixture = fixtureFile
    ? (await import(pathToFileURL(resolve(fixtureFile)).href)).default
    : undefined
  const cacheDir = await mkdtemp(join(tmpdir(), 'aludock-verification-vite-'))
  let server
  const close = async () => {
    try { await server?.close() } finally { await rm(cacheDir, { recursive: true, force: true }) }
  }
  try {
    const config = await resolveConfig({
      root,
      configFile,
      cacheDir,
      plugins: [{
        name: 'verification-preview-no-watch',
        enforce: 'pre',
        config(config) {
          // Vite's merge skips null overrides, so inline watch:null would leave
          // the project's ignored-list watcher enabled. Set it after that merge.
          config.server = { ...config.server, watch: null, hmr: false }
        },
      }, fixture],
      server: { host: '127.0.0.1', port, strictPort: true, watch: null, hmr: false },
    }, 'serve')
    // All config hooks, including async fixture hooks, have finished. Hand Vite
    // this exact resolved config: do not reload it after checking the boundary.
    if (config.configFile !== configFile || config.root !== resolve(root)
      || config.server.watch !== null || config.server.hmr !== false
      || config.server.host !== '127.0.0.1') {
      throw Object.assign(new Error(
        '验证预览必须使用项目配置、关闭文件监听和热更新，并仅监听本机。请移除 fixture 中覆盖这些设置的配置。',
      ), { code: 'unsafe_verification_preview' })
    }
    server = await createServer(config)
    await server.listen()
    const address = server.httpServer.address()
    return { server, url: `http://127.0.0.1:${address.port}`, close }
  } catch (error) {
    await close()
    throw error
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: { port: { type: 'string', default: '1422' }, fixture: { type: 'string' } } })
    const preview = await startVerificationPreview({ port: Number(values.port), fixtureFile: values.fixture })
    console.log(`验证预览：${preview.url}\n项目配置：${configFile}\n文件监听和热更新已关闭；修改源码后请重启预览，再刷新页面。`)
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => {
      await preview.close()
      process.exit(0)
    })
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
