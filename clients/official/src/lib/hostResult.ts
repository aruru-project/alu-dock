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

/** Returns a detached copy of the current Host selection, or throws when none is active. */
export function requireHostContext(app: { hostContext: HostContext | null }): HostContext {
  const context = app.hostContext
  if (!context) throw new Error('当前没有选择 Host。')
  return { ...context }
}

/** Runs a one-shot Dock call and discards the result if the Host selection changed in flight. */
export async function currentHostCall<T>(
  app: { hostContext: HostContext | null },
  operation: (context: HostContext) => Promise<T>,
): Promise<T> {
  const context = requireHostContext(app)
  const correlated = captureHostResult(context, await operation(context))
  if (!hostResultMatches(correlated, app.hostContext)) throw new Error('Host 选择已改变；旧结果已丢弃。')
  return correlated.result
}
