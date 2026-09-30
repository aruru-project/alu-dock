import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { startVerificationPreview } from '../scripts/verification-preview.mjs'

const directory = await mkdtemp(join(tmpdir(), 'aludock-preview-check-'))
let preview
let fixture
try {
  const fixtureFile = join(directory, 'fixture.mjs')
  // 2026-09-30: v0.2.13 exited with code 13 when shutdown interrupted Vite's
  // first import crawl. Hold one real transform until close begins so this
  // test exercises that ordering without relying on machine speed.
  await writeFile(fixtureFile, `
    let started, release
    export const requestStarted = new Promise(resolve => { started = resolve })
    const gate = new Promise(resolve => { release = resolve })
    export const releaseRequest = () => release()
    export let pendingRequest
    export default {
      name: 'preview-check-fixture',
      async configureServer(server) {
        pendingRequest = server.environments.client.transformRequest('/preview-shutdown-gate.js').catch(error => error)
        await requestStarted
      },
      resolveId(id) { if (id === '/preview-shutdown-gate.js') return '\\0preview-shutdown-gate' },
      async load(id) {
        if (id === '\\0preview-shutdown-gate') {
          started()
          await gate
          return 'export const fixture = true'
        }
      },
      transformIndexHtml() { return [{ tag: 'meta', attrs: { name: 'preview-check', content: 'active' } }] },
    }
  `)
  fixture = await import(pathToFileURL(fixtureFile).href)
  preview = await startVerificationPreview({ port: 0, fixtureFile })
  const response = await fetch(preview.url)
  assert.equal(response.status, 200)
  assert.match(await response.text(), /name="preview-check" content="active"/)
  // Loading a real Vue component proves the fixture supplements, rather than
  // replaces, the project's Vue plugin and configuration.
  const component = await fetch(`${preview.url}/src/components/LocalConnectionCard.vue`)
  assert.equal(component.status, 200)
  assert.match(component.headers.get('content-type'), /javascript/)
  await component.text()
  // Regression for the three actual watcher exhaustion incidents. Vite exposes
  // the watched filesystem here; this preview must not subscribe to any tree.
  assert.deepEqual(preview.server.watcher.getWatched(), {})
  const closing = preview.close()
  fixture.releaseRequest()
  await closing
  assert.match((await fixture.pendingRequest).code, /export const fixture = true/)
  preview = undefined

  for (const [name, hook] of [
    ['config', 'config() { return { server: { watch: {} } } }'],
    ['resolved', 'async configResolved(config) { await Promise.resolve(); config.server.watch = {} }'],
  ]) {
    const unsafeFixture = join(directory, `unsafe-${name}.mjs`)
    await writeFile(unsafeFixture, `export default { name: 'accidental-watching', ${hook} }`)
    await assert.rejects(startVerificationPreview({ port: 0, fixtureFile: unsafeFixture }), {
      code: 'unsafe_verification_preview',
    })
  }
  console.log('Project preview renders Vue, closes with a first-crawl request in progress, watches no files, and refuses accidental watcher activation.')
} finally {
  fixture?.releaseRequest()
  await preview?.close()
  await rm(directory, { recursive: true, force: true })
}
