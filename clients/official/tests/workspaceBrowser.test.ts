import assert from 'node:assert/strict'
import { reactive, watch } from 'vue'
import {
  classifyWorkspacePreview,
  mergeWorkspaceDirectoryEntries,
  workspaceDirectoryState,
  workspaceEntryIsDirectory,
  workspaceEntryIsFile,
  type WorkspaceDirectoryState,
} from '../src/lib/workspaceBrowser.ts'
import type { WorkspaceFileEntry } from '../src/lib/types.ts'

function file(path: string, name = path): WorkspaceFileEntry {
  return { path, name, kind: 'file', hidden: false, sizeBytes: 1 }
}

assert.equal(classifyWorkspacePreview(file('diagram.svg', 'diagram.svg')), 'text')
assert.equal(classifyWorkspacePreview(file('page.html', 'page.html')), 'text')
assert.equal(classifyWorkspacePreview(file('manual.pdf', 'manual.pdf')), 'unsupported')
assert.equal(classifyWorkspacePreview(file('photo.webp', 'photo.webp')), 'image')

const oldEntry = file('old.txt')
const nextEntry = file('next.txt')
const changedEntry = file('changed.txt')
assert.deepEqual(
  mergeWorkspaceDirectoryEntries(
    [oldEntry], 'revision-a', [nextEntry], 'revision-a', { revision: 'revision-a', offset: 1 },
  ),
  [oldEntry, nextEntry],
)
assert.deepEqual(
  mergeWorkspaceDirectoryEntries(
    [oldEntry], 'revision-a', [changedEntry], 'revision-b', { revision: 'revision-a', offset: 1 },
  ),
  [changedEntry],
)

const directoryLink: WorkspaceFileEntry = {
  path: 'linked-dir', name: 'linked-dir', kind: 'symlink', hidden: false, targetKind: 'directory',
}
const unavailableLink: WorkspaceFileEntry = {
  path: 'missing', name: 'missing', kind: 'symlink', hidden: false, targetKind: 'unavailable',
}
assert.equal(workspaceEntryIsDirectory(directoryLink), true)
assert.equal(workspaceEntryIsFile(directoryLink), false)
assert.equal(workspaceEntryIsDirectory(unavailableLink), false)
assert.equal(workspaceEntryIsFile(unavailableLink), false)

// 首次打开时状态必须通过 Vue 代理更新，否则请求完成后界面仍会停在“正在读取”。
const directories = reactive<Record<string, WorkspaceDirectoryState>>({})
const root = workspaceDirectoryState(directories, '.')
const observedLoading: boolean[] = []
const stopWatching = watch(() => directories['.']?.loading, (loading) => observedLoading.push(loading), { flush: 'sync' })
root.loading = true
root.entries = [file('README.md')]
root.loading = false
stopWatching()
assert.deepEqual(observedLoading, [true, false])
assert.equal(directories['.'].entries[0]?.path, 'README.md')

console.log('workspace browser tests passed')
