import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchPendingServerRequests, respondServerRequest } from './codexRpcClient'

function jsonResponse(payload: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => payload,
  } as Response
}

describe('device-scoped server requests', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('routes pending snapshots and responses to the device in the hash route', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ data: [] }))
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('window', {
      location: { hash: '#/device/desktop-a/thread/thread-1' },
      localStorage: {
        getItem: () => null,
        setItem: () => {},
        removeItem: () => {},
      },
    })

    await fetchPendingServerRequests()
    await respondServerRequest({ id: 41, result: { decision: 'accept' } })

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      '/codex-api/server-requests/pending?deviceId=desktop-a',
    )
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      '/codex-api/server-requests/respond',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          id: 41,
          result: { decision: 'accept' },
          deviceId: 'desktop-a',
        }),
      }),
    )
  })

  it('preserves local app-server requests when no device is active', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ data: [] }))
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('window', {
      location: { hash: '#/thread/thread-1' },
      localStorage: {
        getItem: () => null,
        setItem: () => {},
        removeItem: () => {},
      },
    })

    await fetchPendingServerRequests()
    await respondServerRequest({ id: 7, result: { decision: 'decline' } })

    expect(fetchMock).toHaveBeenNthCalledWith(1, '/codex-api/server-requests/pending')
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      '/codex-api/server-requests/respond',
      expect.objectContaining({
        body: JSON.stringify({ id: 7, result: { decision: 'decline' } }),
      }),
    )
  })
})
