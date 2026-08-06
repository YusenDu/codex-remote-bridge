import { describe, expect, it } from 'vitest'
import { buildAppRouteLocation, getAppRouteView } from './appRouteContext'

describe('device-aware application routes', () => {
  it('keeps the device id when navigating from a device page to a thread', () => {
    expect(buildAppRouteLocation(
      { params: { deviceId: 'desktop-a' } },
      'thread',
      { threadId: 'thread-1' },
    )).toEqual({
      name: 'device-thread',
      params: { deviceId: 'desktop-a', threadId: 'thread-1' },
    })
  })

  it('uses the regular route names outside a device route', () => {
    expect(buildAppRouteLocation({ params: {} }, 'skills')).toEqual({
      name: 'skills',
      params: {},
    })
  })

  it('maps both regular and device routes to the same application view', () => {
    expect(getAppRouteView('thread')).toBe('thread')
    expect(getAppRouteView('device-thread')).toBe('thread')
    expect(getAppRouteView('device-home')).toBe('home')
  })
})
