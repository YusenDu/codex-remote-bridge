import { describe, expect, it, vi } from 'vitest'
import {
  CodexDesktopCdpBridge,
  type CdpBridgeClient,
  type DesktopBridgeEvent,
} from './codexDesktopCdpBridge'
import type { CdpEvent, CodexRendererTarget } from './types'

class FakeCdpClient implements CdpBridgeClient {
  readonly calls: Array<{ method: string; params: unknown }> = []
  private readonly eventListeners = new Set<(event: CdpEvent) => void>()
  private readonly closeListeners = new Set<(error: Error) => void>()
  close = vi.fn(() => {
    this.emitClose(new Error('closed'))
  })

  constructor(private readonly evaluateValues: unknown[]) {}

  async call<T>(method: string, params?: unknown): Promise<T> {
    this.calls.push({ method, params })
    if (method === 'Runtime.evaluate') {
      return {
        result: {
          type: 'object',
          value: this.evaluateValues.shift(),
        },
      } as T
    }
    return {} as T
  }

  onEvent(listener: (event: CdpEvent) => void): () => void {
    this.eventListeners.add(listener)
    return () => this.eventListeners.delete(listener)
  }

  onClose(listener: (error: Error) => void): () => void {
    this.closeListeners.add(listener)
    return () => this.closeListeners.delete(listener)
  }

  emit(event: CdpEvent): void {
    for (const listener of this.eventListeners) listener(event)
  }

  emitClose(error: Error): void {
    for (const listener of this.closeListeners) listener(error)
  }
}

const target: CodexRendererTarget = {
  port: 60068,
  processId: 40972,
  appVersion: '26.707.3748.0',
  webSocketDebuggerUrl: 'ws://127.0.0.1:60068/devtools/page/main',
}

describe('CodexDesktopCdpBridge', () => {
  it('handshakes and starts a turn through the renderer adapter', async () => {
    const client = new FakeCdpClient([
      { protocol: 1, hostId: 'local', capabilities: ['rpc', 'turn/start', 'turn/interrupt', 'events'] },
      { turn: { id: 'turn-real', status: 'inProgress' } },
    ])
    const bridge = new CodexDesktopCdpBridge({
      discover: async () => target,
      connect: async () => client,
    })

    await expect(bridge.startTurn({
      threadId: 'thread-1',
      input: [{ type: 'text', text: 'hello' }],
    })).resolves.toEqual({ turn: { id: 'turn-real', status: 'inProgress' } })

    expect(client.calls.map((call) => call.method)).toEqual([
      'Runtime.enable',
      'Runtime.addBinding',
      'Runtime.evaluate',
      'Runtime.evaluate',
    ])
    expect(bridge.getStatus()).toMatchObject({
      state: 'ready',
      processId: 40972,
      protocol: 1,
      connectedAtIso: expect.any(String),
      handshakeFingerprint: expect.stringMatching(/^[a-f0-9]{16}$/u),
    })
    expect(JSON.stringify(bridge.getStatus())).not.toContain('webSocketDebuggerUrl')
  })

  it('forwards binding events and interrupts the real turn', async () => {
    const client = new FakeCdpClient([
      { protocol: 1, hostId: 'local', capabilities: ['rpc', 'turn/start', 'turn/interrupt', 'events'] },
      null,
    ])
    const bridge = new CodexDesktopCdpBridge({
      discover: async () => target,
      connect: async () => client,
    })
    const events: DesktopBridgeEvent[] = []
    bridge.subscribe((event) => events.push(event))
    await bridge.connect()

    client.emit({
      method: 'Runtime.bindingCalled',
      params: {
        name: bridge.bindingName,
        payload: JSON.stringify({
          protocol: 1,
          kind: 'notification',
          sequence: 4,
          payload: { method: 'turn/started', params: { threadId: 'thread-1' } },
        }),
      },
    })
    await bridge.interruptTurn({ threadId: 'thread-1', turnId: 'turn-real' })

    expect(events).toEqual([{
      protocol: 1,
      kind: 'notification',
      sequence: 4,
      payload: { method: 'turn/started', params: { threadId: 'thread-1' } },
    }])
    expect(client.calls.at(-1)?.method).toBe('Runtime.evaluate')
  })

  it('forwards generic app-server RPC through the verified Desktop manager', async () => {
    const client = new FakeCdpClient([
      { protocol: 1, hostId: 'local', capabilities: ['rpc', 'turn/start', 'turn/interrupt', 'events'] },
      { data: [{ id: 'thread-1' }] },
    ])
    const bridge = new CodexDesktopCdpBridge({
      discover: async () => target,
      connect: async () => client,
    })

    await expect(bridge.rpc('thread/list', { limit: 20 })).resolves.toEqual({
      data: [{ id: 'thread-1' }],
    })
    expect(client.calls.at(-1)?.method).toBe('Runtime.evaluate')
  })

  it('rejects an incompatible renderer handshake and malformed turn result', async () => {
    const incompatibleClient = new FakeCdpClient([{ protocol: 2, hostId: 'local', capabilities: [] }])
    const incompatibleBridge = new CodexDesktopCdpBridge({
      discover: async () => target,
      connect: async () => incompatibleClient,
    })
    await expect(incompatibleBridge.connect()).rejects.toThrow('protocol')

    const malformedClient = new FakeCdpClient([
      { protocol: 1, hostId: 'local', capabilities: ['rpc', 'turn/start', 'turn/interrupt', 'events'] },
      { turn: {} },
    ])
    const malformedBridge = new CodexDesktopCdpBridge({
      discover: async () => target,
      connect: async () => malformedClient,
    })
    await expect(malformedBridge.startTurn({ threadId: 'thread-1' })).rejects.toThrow('turn id')
  })

  it('rediscovers and reconnects after the renderer socket closes', async () => {
    const firstClient = new FakeCdpClient([
      { protocol: 1, hostId: 'local', capabilities: ['rpc', 'turn/start', 'turn/interrupt', 'events'] },
    ])
    const secondClient = new FakeCdpClient([
      { protocol: 1, hostId: 'local', capabilities: ['rpc', 'turn/start', 'turn/interrupt', 'events'] },
      { turn: { id: 'turn-after-reconnect', status: 'inProgress' } },
    ])
    const connect = vi.fn()
      .mockResolvedValueOnce(firstClient)
      .mockResolvedValueOnce(secondClient)
    const discover = vi.fn().mockResolvedValue(target)
    const bridge = new CodexDesktopCdpBridge({ discover, connect })
    await bridge.connect()

    firstClient.emitClose(new Error('renderer restarted'))

    expect(bridge.getStatus()).toMatchObject({
      state: 'disconnected',
      error: 'renderer restarted',
    })
    await expect(bridge.startTurn({ threadId: 'thread-1' })).resolves.toEqual({
      turn: { id: 'turn-after-reconnect', status: 'inProgress' },
    })
    expect(discover).toHaveBeenCalledTimes(2)
    expect(connect).toHaveBeenCalledTimes(2)
  })

  it('keeps the Desktop event subscription alive after an unexpected disconnect', async () => {
    vi.useFakeTimers()
    try {
      const firstClient = new FakeCdpClient([
        { protocol: 1, hostId: 'local', capabilities: ['rpc', 'turn/start', 'turn/interrupt', 'events'] },
      ])
      const secondClient = new FakeCdpClient([
        { protocol: 1, hostId: 'local', capabilities: ['rpc', 'turn/start', 'turn/interrupt', 'events'] },
      ])
      const connect = vi.fn()
        .mockResolvedValueOnce(firstClient)
        .mockResolvedValueOnce(secondClient)
      const bridge = new CodexDesktopCdpBridge({
        discover: async () => target,
        connect,
        reconnectDelaysMs: [25],
      })
      await bridge.connect()
      bridge.start()

      firstClient.emitClose(new Error('renderer restarted'))
      await vi.advanceTimersByTimeAsync(24)
      expect(connect).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(1)

      expect(connect).toHaveBeenCalledTimes(2)
      expect(bridge.getStatus()).toMatchObject({ state: 'ready', error: null })
      await bridge.dispose()
    } finally {
      vi.useRealTimers()
    }
  })
})
