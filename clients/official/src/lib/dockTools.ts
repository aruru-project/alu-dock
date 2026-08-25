export const DOCK_TOOLS_STATUS_KEY = 'Dock tools'

export type DockToolsState = 'on' | 'off' | 'unavailable'

export function dockToolsState(status: Record<string, string>): DockToolsState {
  const value = status[DOCK_TOOLS_STATUS_KEY]
  if (value === 'on') return 'on'
  if (value === 'unavailable') return 'unavailable'
  return 'off'
}

export function genericExtensionStatus(status: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(status).filter(([key]) => key !== DOCK_TOOLS_STATUS_KEY))
}
