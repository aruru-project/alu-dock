export const DEVICE_NAME_FALLBACK = '这台设备'
export const DEVICE_NAME_PREFERENCE_KEY = 'aludock.deviceName'

export interface DeviceNameStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export function normalizeDeviceName(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim()
  return normalized && [...normalized].length <= 128 ? normalized : null
}

export function readDeviceNamePreference(storage: DeviceNameStorage | null): string | null {
  try {
    return normalizeDeviceName(storage?.getItem(DEVICE_NAME_PREFERENCE_KEY) ?? null)
  } catch {
    return null
  }
}

export function persistDeviceNamePreference(storage: DeviceNameStorage | null, value: unknown): boolean {
  const normalized = normalizeDeviceName(value)
  if (!storage || !normalized) return false
  try {
    storage.setItem(DEVICE_NAME_PREFERENCE_KEY, normalized)
    return true
  } catch {
    return false
  }
}

export function resolveDeviceName(preferred: unknown, paired: unknown, system: unknown): string {
  return normalizeDeviceName(preferred)
    ?? normalizeDeviceName(paired)
    ?? normalizeDeviceName(system)
    ?? DEVICE_NAME_FALLBACK
}

export function browserDeviceNameStorage(): DeviceNameStorage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage
  } catch {
    return null
  }
}
