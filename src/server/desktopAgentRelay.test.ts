import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { decodeAgentMessage, encodeAgentMessage } from '../desktop-agent/protocol'
import {
  DesktopAgentRelay,
  createDesktopAgentTokenAuthenticator,
  type AgentServerSocket,
} from './desktopAgentRelay'

class FakeSocket extends EventEmitter implements AgentServerSocket {
  readyState = 1
  sent: string[] = []
  close = vi.fn((code?: number, reason?: string) => {
    this.readyState = 3
    this.emit('close', code, reason)
  })

  send(data: string): void {
    this.sent.push(data)
  }

  receive(message: Parameters<typeof encodeAgentMessage>[0]): void {
    this.emit('message', encodeAgentMessage(message))
  }
}

async function attachAuthenticatedAgent(relay: DesktopAgentRelay, socket: FakeSocket, deviceId = 'desktop-a') {
  relay.accept(socket, { authorization: 'Bearer pairing-secret' })
  socket.receive({
    version: 1,
    type: 'hello',
    deviceId,
    deviceName: 'Workstation',
    agentVersion: '0.1.87',
    capabilities: ['rpc', 'events'],
  })
  await vi.waitFor(() => expect(socket.sent).toHaveLength(1))
}

describe('DesktopAgentRelay', () => {
  it('expires unauthenticated sockets that do not send hello in time', async () => {
    vi.useFakeTimers()
    try {
      const relay = new DesktopAgentRelay({
        authenticate: async () => true,
        heartbeatIntervalMs: 60_000,
        helloTimeoutMs: 50,
      })
      const socket = new FakeSocket()

      relay.accept(socket, { authorization: 'Bearer pairing-secret' })
      await vi.advanceTimersByTimeAsync(51)

      expect(socket.close).toHaveBeenCalledWith(1008, 'Hello timed out')
      relay.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('caps concurrent unauthenticated sockets', () => {
    const relay = new DesktopAgentRelay({
      authenticate: async () => true,
      heartbeatIntervalMs: 60_000,
      maxUnauthenticatedConnections: 1,
    })
    const first = new FakeSocket()
    const second = new FakeSocket()

    relay.accept(first, { authorization: 'Bearer first' })
    relay.accept(second, { authorization: 'Bearer second' })

    expect(first.close).not.toHaveBeenCalled()
    expect(second.close).toHaveBeenCalledWith(1013, 'Too many unauthenticated connections')
    relay.dispose()
  })

  it('authenticates devices without retaining the raw token', async () => {
    const authenticate = createDesktopAgentTokenAuthenticator({
      CODEXUI_AGENT_PAIRING_TOKEN: 'pairing-secret',
    })
    const relay = new DesktopAgentRelay({ authenticate, heartbeatIntervalMs: 60_000 })
    const socket = new FakeSocket()

    await attachAuthenticatedAgent(relay, socket)

    expect(decodeAgentMessage(socket.sent[0])).toMatchObject({ type: 'hello/ack', accepted: true })
    expect(relay.listDevices()).toEqual([expect.objectContaining({
      deviceId: 'desktop-a',
      deviceName: 'Workstation',
      connected: true,
    })])
    expect(JSON.stringify(relay.listDevices())).not.toContain('pairing-secret')
    relay.dispose()
  })

  it('routes RPC responses, remembers the turn device, and suppresses duplicate events', async () => {
    const relay = new DesktopAgentRelay({
      authenticate: async (_deviceId, token) => token === 'pairing-secret',
      heartbeatIntervalMs: 60_000,
    })
    const socket = new FakeSocket()
    await attachAuthenticatedAgent(relay, socket)
    const events: unknown[] = []
    relay.subscribeEvents((event) => events.push(event))

    const startPromise = relay.rpc('turn/start', { threadId: 'thread-1', input: [] })
    const startRequest = decodeAgentMessage(socket.sent.at(-1))
    expect(startRequest).toMatchObject({ type: 'request', method: 'rpc' })
    if (startRequest.type !== 'request') throw new Error('Expected request')
    socket.receive({
      version: 1,
      type: 'response',
      id: startRequest.id,
      ok: true,
      result: { turn: { id: 'turn-real' } },
    })
    await expect(startPromise).resolves.toEqual({ turn: { id: 'turn-real' } })

    const interruptPromise = relay.rpc('turn/interrupt', { threadId: 'thread-1', turnId: 'turn-real' })
    const interruptRequest = decodeAgentMessage(socket.sent.at(-1))
    if (interruptRequest.type !== 'request') throw new Error('Expected request')
    socket.receive({ version: 1, type: 'response', id: interruptRequest.id, ok: true, result: {} })
    await expect(interruptPromise).resolves.toEqual({})

    const desktopEvent = { protocol: 1, kind: 'notification', sequence: 4, payload: { method: 'turn/started' } }
    socket.receive({ version: 1, type: 'event', sequence: 7, event: desktopEvent })
    socket.receive({ version: 1, type: 'event', sequence: 7, event: desktopEvent })
    expect(events).toEqual([{ deviceId: 'desktop-a', event: desktopEvent }])
    relay.dispose()
  })

  it('reassembles bounded out-of-order response chunks', async () => {
    const relay = new DesktopAgentRelay({
      authenticate: async () => true,
      heartbeatIntervalMs: 60_000,
    })
    const socket = new FakeSocket()
    await attachAuthenticatedAgent(relay, socket)

    const responsePromise = relay.rpc('thread/read', { threadId: 'thread-large' })
    const request = decodeAgentMessage(socket.sent.at(-1))
    if (request.type !== 'request') throw new Error('Expected request')
    const response = Buffer.from(JSON.stringify({
      version: 1,
      type: 'response',
      id: request.id,
      ok: true,
      result: { messages: ['x'.repeat(2_048)] },
    }), 'utf8')
    const middle = Math.ceil(response.length / 2)
    const chunks = [response.subarray(0, middle), response.subarray(middle)]
    socket.receive({
      version: 1,
      type: 'response/chunk',
      id: request.id,
      index: 1,
      total: 2,
      encoding: 'base64-json',
      data: chunks[1].toString('base64'),
    })
    socket.receive({
      version: 1,
      type: 'response/chunk',
      id: request.id,
      index: 0,
      total: 2,
      encoding: 'base64-json',
      data: chunks[0].toString('base64'),
    })

    await expect(responsePromise).resolves.toEqual({ messages: ['x'.repeat(2_048)] })
    relay.dispose()
  })

  it('rejects ambiguous routing and expires unresponsive devices', async () => {
    let now = 1_000
    const relay = new DesktopAgentRelay({
      authenticate: async () => true,
      now: () => now,
      heartbeatIntervalMs: 60_000,
      heartbeatTimeoutMs: 500,
    })
    const first = new FakeSocket()
    const second = new FakeSocket()
    relay.accept(first, { authorization: 'Bearer token-a' })
    first.receive({
      version: 1,
      type: 'hello',
      deviceId: 'desktop-a',
      deviceName: 'A',
      agentVersion: '0.1.87',
      capabilities: ['rpc'],
    })
    relay.accept(second, { authorization: 'Bearer token-b' })
    second.receive({
      version: 1,
      type: 'hello',
      deviceId: 'desktop-b',
      deviceName: 'B',
      agentVersion: '0.1.87',
      capabilities: ['rpc'],
    })
    await vi.waitFor(() => expect(relay.listDevices()).toHaveLength(2))

    await expect(relay.rpc('thread/list', {})).rejects.toThrow('device')
    now = 1_501
    relay.sweepHeartbeat()
    expect(first.close).toHaveBeenCalled()
    expect(second.close).toHaveBeenCalled()
    relay.dispose()
  })
})
