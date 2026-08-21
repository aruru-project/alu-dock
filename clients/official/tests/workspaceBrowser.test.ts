import assert from 'node:assert/strict'
import {
  classifyWorkspacePreview,
  mergeWorkspaceDirectoryEntries,
  workspaceEntryIsDirectory,
  workspaceEntryIsFile,
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

console.log('workspace browser tests passed')
