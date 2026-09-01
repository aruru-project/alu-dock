import type { WorkspaceFileCursor, WorkspaceFileEntry, WorkspacePage } from './types'

export type WorkspacePreviewKind = 'text' | 'image' | 'unsupported'

export interface WorkspaceDirectoryState {
  entries: WorkspaceFileEntry[]
  revision: string
  nextCursor?: WorkspaceFileCursor
  loading: boolean
  error: string
  loadToken: number
}

export function workspaceDirectoryState(
  directories: Record<string, WorkspaceDirectoryState>,
  path: string,
): WorkspaceDirectoryState {
  if (!directories[path]) {
    directories[path] = {
      entries: [], revision: '', nextCursor: undefined, loading: false, error: '', loadToken: 0,
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

export function workspaceDirectoryRefreshPaths(
  mobile: boolean,
  mobilePath: string,
  expandedPaths: ReadonlySet<string>,
  directories: Readonly<Record<string, WorkspaceDirectoryState>>,
): string[] {
  if (mobile) return [mobilePath]
  return [...new Set(['.', ...expandedPaths])]
    .filter((path) => path === '.' || directories[path] !== undefined)
    .sort((left, right) => pathDepth(left) - pathDepth(right) || left.localeCompare(right))
}

export function appendWorkspacePage(current: WorkspacePage, next: WorkspacePage): WorkspacePage {
  return { ...next, entries: [...current.entries, ...next.entries] }
}

function pathDepth(path: string): number {
  return path === '.' ? 0 : path.split('/').length
}

function extensionOf(name: string): string {
  const base = name.toLowerCase()
  const index = base.lastIndexOf('.')
  return index > 0 ? base.slice(index + 1) : ''
}
