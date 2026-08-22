import type { MachineDto } from './types'

export function machineSelectorVisible(machines: readonly MachineDto[]) {
  return machines.length >= 2
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
