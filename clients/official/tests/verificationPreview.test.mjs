import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startVerificationPreview } from '../scripts/verification-preview.mjs'

const directory = await mkdtemp(join(tmpdir(), 'aludock-preview-check-'))
let preview
try {
  const fixtureFile = join(directory, 'fixture.mjs')
  await writeFile(fixtureFile, `export default {
    name: 'preview-check-fixture',
    transformIndexHtml() { return [{ tag: 'meta', attrs: { name: 'preview-check', content: 'active' } }] },
  }`)
  preview = await startVerificationPreview({ port: 0, fixtureFile })
  const response = await fetch(preview.url)
  assert.equal(response.status, 200)
  assert.match(await response.text(), /name="preview-check" content="active"/)
  // Loading a real Vue component proves the fixture supplements, rather than
  // replaces, the project's Vue plugin and configuration.
  const component = await fetch(`${preview.url}/src/components/LocalConnectionCard.vue`)
  assert.equal(component.status, 200)
  assert.match(component.headers.get('content-type'), /javascript/)
  // Regression for the three actual watcher exhaustion incidents. Vite exposes
  // the watched filesystem here; this preview must not subscribe to any tree.
  assert.deepEqual(preview.server.watcher.getWatched(), {})
  await preview.close()
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
  console.log('Project preview renders Vue with fixture plugins, watches no files, and refuses accidental watcher activation.')
} finally {
  await preview?.close()
  await rm(directory, { recursive: true, force: true })
}
