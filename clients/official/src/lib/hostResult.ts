import type { HostContext } from './types'

/** Correlates a one-shot Dock result with the exact Host selection that issued it. */
export interface HostResult<T> extends HostContext { result: T }

export function captureHostResult<T>(context: HostContext, result: T): HostResult<T> {
  return { hostId: context.hostId, selectionGeneration: context.selectionGeneration, result }
}

export function hostResultMatches<T>(value: HostResult<T>, current: HostContext | null | undefined): boolean {
  return !!current
    && value.hostId === current.hostId
    && value.selectionGeneration === current.selectionGeneration
}
