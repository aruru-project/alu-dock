import type { MachineDto, MachinePlatform } from './types'

const WORKSPACE_ROOT_FALLBACK = '/'

export function machineSelectorVisible(machines: readonly MachineDto[]) {
  return machines.length >= 2
}

export function subhostMachineName(machines: readonly MachineDto[], hostId: string | undefined) {
  if (!hostId) return ''
  const machine = machines.find((candidate) => candidate.hostId === hostId)
  return machine?.kind === 'subhost' ? machine.name : ''
}

export function machineDisplayLabel(machine: MachineDto) {
  const kind = machine.kind === 'main' ? 'Main' : 'SubHost'
  return machine.name.trim().toLocaleLowerCase('en-US') === kind.toLocaleLowerCase('en-US')
    ? machine.name
    : `${machine.name} · ${kind}`
}

export function defaultMachineHostId(machines: readonly MachineDto[]) {
  const main = machines.find((machine) => machine.kind === 'main' && machine.available)
  return main?.hostId ?? machines.find((machine) => machine.available)?.hostId ?? ''
}

export function selectedMachineTarget(
  machines: readonly MachineDto[],
  selectedHostId: string,
): string | undefined {
  if (!machineSelectorVisible(machines)) return undefined
  const selected = machines.find((machine) => machine.hostId === selectedHostId && machine.available)
  return selected?.hostId ?? (defaultMachineHostId(machines) || undefined)
}

/** Machine-level Host settings and model lists name the connected Host by omitting the target. */
export function machineRequestTarget(machine: MachineDto | undefined): string | undefined {
  return !machine || machine.kind === 'main' ? undefined : machine.hostId
}

export function machineWorkspaceStart(machine: MachineDto | undefined) {
  return machine?.homePath || WORKSPACE_ROOT_FALLBACK
}

export function machineWorkspaceRoots(machine: MachineDto | undefined): readonly string[] {
  return machine?.workspaceRoots ?? []
}

export function machineWorkspaceRootSelectorVisible(machine: MachineDto | undefined) {
  return machineWorkspaceRoots(machine).length >= 2
}

function windowsPaths(path: string, platform?: MachinePlatform) {
  return platform === 'windows'
    || (platform === undefined && (/^[A-Za-z]:[\\/]/.test(path) || path.startsWith('\\\\')))
}

export function workspaceChildPath(path: string, name: string, platform?: MachinePlatform) {
  const windows = windowsPaths(path, platform)
  const separator = windows ? '\\' : '/'
  const trailingSeparators = windows ? /[\\/]+$/ : /\/+$/
  return `${path.replace(trailingSeparators, '')}${separator}${name}`
}

/**
 * What the directory picker's search box means as a destination: an absolute path, `~`
 * for the Machine's Home, or a path relative to the directory being viewed. Plain text
 * (no separator) is a name filter and resolves to nothing.
 */
export function typedDirectoryTarget(input: string, current: string, homePath: string | undefined, platform?: MachinePlatform): string | undefined {
  const text = input.trim()
  if (!text) return undefined
  const windows = windowsPaths(current, platform)
  const separators = windows ? /[\\/]/ : /\//
  if (text === '~' || /^~[\\/]/.test(text)) {
    if (!homePath) return undefined
    const rest = text.slice(1).replace(windows ? /^[\\/]+/ : /^\/+/, '')
    return rest ? workspaceChildPath(homePath, rest.replace(/\//g, windows ? '\\' : '/'), platform) : homePath
  }
  if (/^[A-Za-z]:[\\/]/.test(text) || text.startsWith('\\\\') || (!windows && text.startsWith('/'))) return text
  if (!separators.test(text)) return undefined
  return workspaceChildPath(current, text.replace(windows ? /^[\\/]+|[\\/]+$/g : /^\/+|\/+$/g, '').replace(/\//g, windows ? '\\' : '/'), platform)
}
