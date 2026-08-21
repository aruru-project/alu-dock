import type { WorkspaceFileCursor, WorkspaceFileEntry } from './types'

export type WorkspacePreviewKind = 'text' | 'image' | 'unsupported'

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp'])
const TEXT_EXTENSIONS = new Set([
  'c', 'cc', 'cpp', 'cs', 'css', 'csv', 'dart', 'env', 'go', 'h', 'hpp', 'html', 'ini',
  'java', 'js', 'json', 'jsx', 'kt', 'kts', 'less', 'lock', 'log', 'lua', 'md', 'mjs',
  'php', 'plist', 'properties', 'py', 'rb', 'rs', 'sass', 'scss', 'sh', 'sql', 'svg',
  'swift', 'toml', 'ts', 'tsx', 'txt', 'vue', 'xml', 'yaml', 'yml', 'zsh',
])
const TEXT_BASENAMES = new Set([
  'dockerfile', 'gemfile', 'license', 'makefile', 'readme', 'rakefile',
])

export function workspaceEntryIsDirectory(entry: WorkspaceFileEntry): boolean {
  return entry.kind === 'directory' || (entry.kind === 'symlink' && entry.targetKind === 'directory')
}

export function workspaceEntryIsFile(entry: WorkspaceFileEntry): boolean {
  return entry.kind === 'file' || (entry.kind === 'symlink' && entry.targetKind === 'file')
}

export function classifyWorkspacePreview(entry: WorkspaceFileEntry): WorkspacePreviewKind {
  const extension = extensionOf(entry.name)
  if (IMAGE_EXTENSIONS.has(extension)) return 'image'
  const basename = entry.name.toLowerCase().replace(/\.[^.]+$/, '')
  if (!extension || TEXT_EXTENSIONS.has(extension) || TEXT_BASENAMES.has(basename)) return 'text'
  return 'unsupported'
}

export function mergeWorkspaceDirectoryEntries(
  existingEntries: WorkspaceFileEntry[],
  existingRevision: string,
  pageEntries: WorkspaceFileEntry[],
  pageRevision: string,
  requestedCursor?: WorkspaceFileCursor,
): WorkspaceFileEntry[] {
  if (!requestedCursor || requestedCursor.revision !== existingRevision || pageRevision !== existingRevision) {
    return pageEntries
  }
  return [...existingEntries, ...pageEntries]
}

function extensionOf(name: string): string {
  const base = name.toLowerCase()
  const index = base.lastIndexOf('.')
  return index > 0 ? base.slice(index + 1) : ''
}
