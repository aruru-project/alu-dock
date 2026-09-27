import type { WorkspaceFileCursor, WorkspaceFileEntry, WorkspaceFilePage } from './types'

// UI input only. Each caller keeps its own request context and path rules.
export type DirectoryPage = Pick<WorkspaceFilePage, 'path' | 'entries' | 'revision' | 'nextCursor'> & { parent?: string }

export type WorkspacePreviewKind = 'text' | 'image' | 'unsupported'

export interface WorkspaceDirectoryState {
  path: string
  parent?: string
  entries: WorkspaceFileEntry[]
  revision: string
  nextCursor?: WorkspaceFileCursor
  loading: boolean
  error: string
  diagnostic?: string
  diagnosticCopyState?: 'copied' | 'failed'
  loadToken: number
}

export function workspaceDirectoryState(
  directories: Record<string, WorkspaceDirectoryState>,
  path: string,
): WorkspaceDirectoryState {
  if (!directories[path]) {
    directories[path] = {
      path, entries: [], revision: '', nextCursor: undefined, loading: false, error: '', loadToken: 0,
    }
  }
  return directories[path]
}

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp'])
const MARKDOWN_EXTENSIONS = new Set(['md', 'markdown'])
const TEXT_EXTENSIONS = new Set([
  'c', 'cc', 'cpp', 'cs', 'css', 'csv', 'dart', 'env', 'go', 'h', 'hpp', 'html', 'ini',
  'java', 'js', 'json', 'jsx', 'kt', 'kts', 'less', 'lock', 'log', 'lua', 'md', 'mjs',
  'php', 'plist', 'properties', 'py', 'rb', 'rs', 'sass', 'scss', 'sh', 'sql', 'svg',
  'swift', 'toml', 'ts', 'tsx', 'txt', 'vue', 'xml', 'yaml', 'yml', 'zsh',
])
const TEXT_BASENAMES = new Set([
  'dockerfile', 'gemfile', 'license', 'makefile', 'readme', 'rakefile',
])

export function formatWorkspaceBytes(value?: number): string {
  if (value == null) return '—'
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(value < 10 * 1024 ? 1 : 0)} KiB`
  return `${(value / 1024 / 1024).toFixed(value < 10 * 1024 * 1024 ? 1 : 0)} MiB`
}

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

export function workspaceEntryIsMarkdown(entry: WorkspaceFileEntry): boolean {
  const name = entry.name.toLowerCase()
  return MARKDOWN_EXTENSIONS.has(extensionOf(name)) || name === 'readme'
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
