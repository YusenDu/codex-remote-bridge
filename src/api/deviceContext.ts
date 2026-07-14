export type DeviceStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

const ACTIVE_DEVICE_KEY = 'codexapp.activeDeviceId'
let fallbackActiveDeviceId: string | null = null

function browserStorage(): DeviceStorage | null {
  if (typeof window === 'undefined') return null
  try {
    return window.localStorage
  } catch {
    return null
  }
}

export function normalizeDeviceId(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim()
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(normalized)) return null
  return normalized
}

export function getActiveDeviceId(storage: DeviceStorage | null = browserStorage()): string | null {
  if (!storage) return fallbackActiveDeviceId
  try {
    return normalizeDeviceId(storage.getItem(ACTIVE_DEVICE_KEY))
  } catch {
    return fallbackActiveDeviceId
  }
}

export function setActiveDeviceId(
  value: unknown,
  storage: DeviceStorage | null = browserStorage(),
): string | null {
  const normalized = normalizeDeviceId(value)
  if (!normalized) return null
  fallbackActiveDeviceId = normalized
  try {
    storage?.setItem(ACTIVE_DEVICE_KEY, normalized)
  } catch {
    // The in-memory selection remains available when browser storage is blocked.
  }
  return normalized
}

export function clearActiveDeviceId(storage: DeviceStorage | null = browserStorage()): void {
  fallbackActiveDeviceId = null
  try {
    storage?.removeItem(ACTIVE_DEVICE_KEY)
  } catch {
    // Clearing the in-memory selection is sufficient when browser storage is blocked.
  }
}
