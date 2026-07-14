import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearActiveDeviceId, setActiveDeviceId } from './deviceContext'
import { rpcCall, subscribeRpcNotifications } from './codexRpcClient'

class MemoryStorage {
  private readonly values = new Map<string, string>()

  getItem(key: string): string | null {
    return this.values.get(key) ?? null
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value)
  }

  removeItem(key: string): void {
    this.values.delete(key)
  }
}

class FakeWebSocket {
  static readonly instances: FakeWebSocket[] = []
  static readonly OPEN = 1
  readonly url: string
  readyState = FakeWebSocket.OPEN
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onerror: (() => void) | null = null
  onclose: (() => void) | null = null

  constructor(url: string) {
    this.url = url
    FakeWebSocket.instances.push(this)
  }

  close(): void {
    this.readyState = 3
  }
}

const originalWindow = globalThis.window
const originalWebSocket = globalThis.WebSocket
const originalFetch = globalThis.fetch

describe('Codex RPC device routing', () => {
  beforeEach(() => {
    FakeWebSocket.instances.length = 0
    const localStorage = new MemoryStorage()
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        localStorage,
        location: { protocol: 'https:', host: 'codex.example.com' },
        setTimeout,
        clearTimeout,
      },
    })
    Object.defineProperty(globalThis, 'WebSocket', {
      configurable: true,
      value: FakeWebSocket,
    })
    setActiveDeviceId('desktop-a')
  })

  afterEach(() => {
    clearActiveDeviceId()
    vi.restoreAllMocks()
    Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow })
    Object.defineProperty(globalThis, 'WebSocket', { configurable: true, value: originalWebSocket })
    Object.defineProperty(globalThis, 'fetch', { configurable: true, value: originalFetch })
  })

  it('adds the selected machine code to every RPC request', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({ result: { ok: true } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))
    Object.defineProperty(globalThis, 'fetch', { configurable: true, value: fetchMock })

    await rpcCall('thread/list', { limit: 10 })

    const request = fetchMock.mock.calls[0]
    expect(request?.[0]).toBe('/codex-api/rpc')
    expect(JSON.parse(String(request?.[1]?.body))).toEqual({
      method: 'thread/list',
      params: { limit: 10 },
      deviceId: 'desktop-a',
    })
  })

  it('scopes the default realtime subscription to the selected machine', () => {
    const dispose = subscribeRpcNotifications(() => {})

    expect(FakeWebSocket.instances).toHaveLength(1)
    expect(FakeWebSocket.instances[0]?.url).toBe(
      'wss://codex.example.com/codex-api/ws?deviceId=desktop-a',
    )
    dispose()
  })
})
