import assert from 'node:assert/strict'
import { reactive, watch } from 'vue'
import {
  appendWorkspacePage,
  classifyWorkspacePreview,
  mergeWorkspaceDirectoryEntries,
  workspaceDirectoryRefreshPaths,
  workspaceDirectoryState,
  workspaceEntryIsDirectory,
  workspaceEntryIsFile,
  workspaceEntryIsMarkdown,
  type WorkspaceDirectoryState,
} from '../src/lib/workspaceBrowser.ts'
import type { WorkspaceFileEntry, WorkspacePage } from '../src/lib/types.ts'

function file(path: string, name = path): WorkspaceFileEntry {
  return { path, name, kind: 'file', hidden: false, sizeBytes: 1 }
}

assert.equal(classifyWorkspacePreview(file('diagram.svg', 'diagram.svg')), 'text')
assert.equal(classifyWorkspacePreview(file('page.html', 'page.html')), 'text')
assert.equal(classifyWorkspacePreview(file('manual.pdf', 'manual.pdf')), 'unsupported')
assert.equal(classifyWorkspacePreview(file('photo.webp', 'photo.webp')), 'image')
assert.equal(workspaceEntryIsMarkdown(file('README.md', 'README.md')), true)
assert.equal(workspaceEntryIsMarkdown(file('guide.markdown', 'guide.markdown')), true)
assert.equal(workspaceEntryIsMarkdown(file('README', 'README')), true)
assert.equal(workspaceEntryIsMarkdown(file('notes.txt', 'notes.txt')), false)

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

const refreshDirectories: Record<string, WorkspaceDirectoryState> = {
  '.': { entries: [], revision: 'root', loading: false, error: '', loadToken: 0 },
  src: { entries: [], revision: 'src', loading: false, error: '', loadToken: 0 },
  'src/lib': { entries: [], revision: 'lib', loading: false, error: '', loadToken: 0 },
}
assert.deepEqual(
  workspaceDirectoryRefreshPaths(false, '.', new Set(['.', 'src', 'src/lib']), refreshDirectories),
  ['.', 'src', 'src/lib'],
)
assert.deepEqual(
  workspaceDirectoryRefreshPaths(true, 'src/lib', new Set(['.', 'src']), refreshDirectories),
  ['src/lib'],
)

const firstWorkspacePage: WorkspacePage = {
  path: '/work', revision: 'browse-a', entries: [{ name: 'a', kind: 'directory', hidden: false }],
  total: 2, truncated: true, nextCursor: { revision: 'browse-a', offset: 1 },
}
const finalWorkspacePage: WorkspacePage = {
  path: '/work', revision: 'browse-a', entries: [{ name: 'b', kind: 'directory', hidden: false }],
  total: 2, truncated: false,
}
assert.deepEqual(appendWorkspacePage(firstWorkspacePage, finalWorkspacePage), {
  ...finalWorkspacePage,
  entries: [...firstWorkspacePage.entries, ...finalWorkspacePage.entries],
})

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
