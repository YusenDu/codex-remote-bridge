import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import type { DesktopBridgeEvent, DesktopBridgeStatus } from '../server/codexDesktopCdp/codexDesktopCdpBridge'
import {
  DesktopAgentConnection,
  toAgentWebSocketUrl,
  type AgentClientSocket,
} from './agentConnection'
import { decodeAgentMessage, encodeAgentMessage } from './protocol'

class FakeSocket extends EventEmitter implements AgentClientSocket {
  readyState = 0
  sent: string[] = []

  send(data: string): void {
    this.sent.push(data)
  }

  close(): void {
    this.readyState = 3
    this.emit('close')
  }

  open(): void {
    this.readyState = 1
    this.emit('open')
  }

  receive(message: Parameters<typeof encodeAgentMessage>[0]): void {
    this.emit('message', encodeAgentMessage(message))
  }
}

function createBridge() {
  let eventListener: ((event: DesktopBridgeEvent) => void) | null = null
  const status: DesktopBridgeStatus = {
    state: 'ready',
    processId: 40972,
    appVersion: '26.707.3748.0',
    protocol: 1,
    handshakeFingerprint: '0123456789abcdef',
    connectedAtIso: '2026-07-10T09:00:00.000Z',
    error: null,
  }
  return {
    rpc: vi.fn().mockResolvedValue({ data: [{ id: 'thread-1' }] }),
    getStatus: vi.fn(() => status),
    subscribe: vi.fn((listener: (event: DesktopBridgeEvent) => void) => {
      eventListener = listener
      return () => {
        eventListener = null
      }
    }),
    emit(event: DesktopBridgeEvent) {
      eventListener?.(event)
    },
  }
}

describe('DesktopAgentConnection', () => {
  it('requires TLS except for loopback development servers', () => {
    expect(toAgentWebSocketUrl('https://codex.example.com/base/')).toBe(
      'wss://codex.example.com/base/codex-api/agent/ws',
    )
    expect(toAgentWebSocketUrl('http://127.0.0.1:5900')).toBe(
      'ws://127.0.0.1:5900/codex-api/agent/ws',
    )
    expect(() => toAgentWebSocketUrl('http://codex.example.com')).toThrow('HTTPS')
  })

  it('authenticates, executes idempotent RPC requests, relays events, and answers heartbeat', async () => {
    const socket = new FakeSocket()
    const bridge = createBridge()
    const createSocket = vi.fn(() => socket)
    const connection = new DesktopAgentConnection({
      serverUrl: 'https://codex.example.com',
      deviceId: 'desktop-a',
      deviceName: 'Workstation',
      token: 'pairing-secret',
      agentVersion: '0.1.87',
      bridge,
      createSocket,
      reconnectDelaysMs: [25],
    })

    connection.start()
    socket.open()
    const hello = decodeAgentMessage(socket.sent[0])
    expect(hello).toMatchObject({ type: 'hello', deviceId: 'desktop-a' })
    expect(JSON.stringify(hello)).not.toContain('pairing-secret')
    expect(createSocket).toHaveBeenCalledWith(
      'wss://codex.example.com/codex-api/agent/ws',
      { headers: { authorization: 'Bearer pairing-secret' } },
    )

    socket.receive({
      version: 1,
      type: 'hello/ack',
      accepted: true,
      serverTimeIso: '2026-07-10T09:00:00.000Z',
    })
    const request = {
      version: 1,
      type: 'request',
      id: 'req-1',
      method: 'rpc',
      params: { method: 'thread/list', params: { limit: 20 } },
    } as const
    socket.receive(request)
    socket.receive(request)
    await vi.waitFor(() => expect(socket.sent.filter((entry) => (
      decodeAgentMessage(entry).type === 'response'
    ))).toHaveLength(2))
    expect(bridge.rpc).toHaveBeenCalledTimes(1)
    expect(bridge.rpc).toHaveBeenCalledWith('thread/list', { limit: 20 })

    bridge.emit({ protocol: 1, kind: 'notification', sequence: 8, payload: { method: 'turn/started' } })
    socket.receive({ version: 1, type: 'ping', nonce: 'heartbeat-1' })
    expect(socket.sent.map((entry) => decodeAgentMessage(entry))).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'event', sequence: 1 }),
      { version: 1, type: 'pong', nonce: 'heartbeat-1' },
    ]))
    expect(connection.getStatus()).toMatchObject({ state: 'connected', deviceId: 'desktop-a' })

    connection.stop()
  })

  it('reconnects with bounded backoff and stops retrying after shutdown', async () => {
    vi.useFakeTimers()
    try {
      const first = new FakeSocket()
      const second = new FakeSocket()
      const sockets = [first, second]
      const connection = new DesktopAgentConnection({
        serverUrl: 'https://codex.example.com',
        deviceId: 'desktop-a',
        deviceName: 'Workstation',
        token: 'pairing-secret',
        agentVersion: '0.1.87',
        bridge: createBridge(),
        createSocket: vi.fn(() => sockets.shift()!),
        reconnectDelaysMs: [25],
      })
      connection.start()
      first.open()
      first.receive({
        version: 1,
        type: 'hello/ack',
        accepted: true,
        serverTimeIso: '2026-07-10T09:00:00.000Z',
      })
      first.close()

      await vi.advanceTimersByTimeAsync(25)
      expect(connection.getStatus().state).toBe('connecting')
      second.open()
      second.receive({
        version: 1,
        type: 'hello/ack',
        accepted: true,
        serverTimeIso: '2026-07-10T09:00:00.000Z',
      })
      expect(connection.getStatus().state).toBe('connected')

      connection.stop()
      await vi.runOnlyPendingTimersAsync()
      expect(connection.getStatus().state).toBe('stopped')
    } finally {
      vi.useRealTimers()
    }
  })
})
