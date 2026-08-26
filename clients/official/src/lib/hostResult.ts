import type { ConnectionContext } from './types'

/** Correlates a one-shot Dock result with the exact connection selection that issued it. */
export interface ConnectionResult<T> extends ConnectionContext { result: T }

export function captureConnectionResult<T>(context: ConnectionContext, result: T): ConnectionResult<T> {
  return { connectionId: context.connectionId, selectionGeneration: context.selectionGeneration, result }
}

export function hostResultMatches<T>(value: ConnectionResult<T>, current: ConnectionContext | null | undefined): boolean {
  return !!current
    && value.connectionId === current.connectionId
    && value.selectionGeneration === current.selectionGeneration
}

/** Returns a detached copy of the current connection selection, or throws when none is active. */
export function requireConnectionContext(app: { connectionContext: ConnectionContext | null }): ConnectionContext {
  const context = app.connectionContext
  if (!context) throw new Error('当前没有连接 AluDock。')
  return { ...context }
}

/** Runs a one-shot Dock call and discards the result if the connection selection changed in flight. */
export async function currentConnectionCall<T>(
  app: { connectionContext: ConnectionContext | null },
  operation: (context: ConnectionContext) => Promise<T>,
): Promise<T> {
  const context = requireConnectionContext(app)
  const correlated = captureConnectionResult(context, await operation(context))
  if (!hostResultMatches(correlated, app.connectionContext)) throw new Error('当前连接已切换，请重试。')
  return correlated.result
}
