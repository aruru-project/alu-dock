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

export function machineWorkspaceStart(machine: MachineDto | undefined) {
  return machine?.homePath || WORKSPACE_ROOT_FALLBACK
}

export function machineWorkspaceRoots(machine: MachineDto | undefined): readonly string[] {
  return machine?.workspaceRoots ?? []
}

export function machineWorkspaceRootSelectorVisible(machine: MachineDto | undefined) {
  return machineWorkspaceRoots(machine).length >= 2
}

export function workspaceChildPath(path: string, name: string, platform?: MachinePlatform) {
  const windows = platform === 'windows'
    || (platform === undefined && (/^[A-Za-z]:[\\/]/.test(path) || path.startsWith('\\\\')))
  const separator = windows ? '\\' : '/'
  const trailingSeparators = windows ? /[\\/]+$/ : /\/+$/
  return `${path.replace(trailingSeparators, '')}${separator}${name}`
}
