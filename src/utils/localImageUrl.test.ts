import { describe, expect, it } from 'vitest'
import type { DeviceStorage } from '../api/deviceContext'
import { routeLocalImageUrl } from './localImageUrl'

function deviceStorage(deviceId: string): DeviceStorage {
  return {
    getItem: () => deviceId,
    setItem: () => undefined,
    removeItem: () => undefined,
  }
}

describe('routeLocalImageUrl', () => {
  it('routes desktop-local images through the selected agent and thread', () => {
    const routed = routeLocalImageUrl(
      '/codex-local-image?path=C%3A%5CUsers%5Ctester%5Cscreenshot.png',
      'thread-1',
      deviceStorage('desktop-a'),
    )
    const parsed = new URL(routed, 'https://bridge.example')

    expect(parsed.pathname).toBe('/codex-local-image')
    expect(parsed.searchParams.get('path')).toBe('C:\\Users\\tester\\screenshot.png')
    expect(parsed.searchParams.get('source')).toBe('desktop')
    expect(parsed.searchParams.get('threadId')).toBe('thread-1')
    expect(parsed.searchParams.get('deviceId')).toBe('desktop-a')
  })

  it('leaves relay-local and external images unchanged', () => {
    const relayImage = '/codex-local-image?path=%2Ftmp%2Finline.png&source=server'
    expect(routeLocalImageUrl(relayImage, 'thread-1', deviceStorage('desktop-a'))).toBe(relayImage)
    expect(routeLocalImageUrl('https://example.com/image.png', 'thread-1', deviceStorage('desktop-a')))
      .toBe('https://example.com/image.png')
  })
})
