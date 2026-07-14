import { describe, expect, it } from 'vitest'
import {
  appendActiveDeviceId,
  clearActiveDeviceId,
  getActiveDeviceId,
  normalizeDeviceId,
  setActiveDeviceId,
  type DeviceStorage,
} from './deviceContext'

function memoryStorage(): DeviceStorage {
  const values = new Map<string, string>()
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  }
}

describe('device context', () => {
  it('accepts only relay-safe machine codes', () => {
    expect(normalizeDeviceId(' desktop-a:b ')).toBe('desktop-a:b')
    expect(normalizeDeviceId('../desktop-a')).toBeNull()
    expect(normalizeDeviceId('-desktop-a')).toBeNull()
    expect(normalizeDeviceId('')).toBeNull()
    expect(normalizeDeviceId(`d${'a'.repeat(128)}`)).toBeNull()
  })

  it('persists and clears the selected machine', () => {
    const storage = memoryStorage()

    expect(setActiveDeviceId('desktop-a', storage)).toBe('desktop-a')
    expect(getActiveDeviceId(storage)).toBe('desktop-a')
    clearActiveDeviceId(storage)
    expect(getActiveDeviceId(storage)).toBeNull()
  })

  it('does not replace a valid selection with an unsafe machine code', () => {
    const storage = memoryStorage()
    setActiveDeviceId('desktop-a', storage)

    expect(setActiveDeviceId('../desktop-b', storage)).toBeNull()
    expect(getActiveDeviceId(storage)).toBe('desktop-a')
  })

  it('adds the selected machine to non-RPC API query parameters', () => {
    const storage = memoryStorage()
    setActiveDeviceId('desktop-a', storage)
    const query = new URLSearchParams({ cwd: 'K:\\project' })

    appendActiveDeviceId(query, storage)

    expect(query.get('deviceId')).toBe('desktop-a')
    expect(query.get('cwd')).toBe('K:\\project')
  })
})
