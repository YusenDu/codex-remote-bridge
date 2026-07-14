import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import WebSocket from 'ws'
import {
  AGENT_PROTOCOL_VERSION,
  MAX_AGENT_RESPONSE_BYTES,
  decodeAgentMessage,
  decodeReassembledAgentResponse,
  encodeAgentMessage,
  type AgentHelloMessage,
  type AgentResponseMessage,
  type AgentResponseChunkMessage,
} from '../desktop-agent/protocol'

export interface AgentServerSocket {
  readyState: number
  send(data: string): void
  close(code?: number, reason?: string): void
  on(event: string, listener: (...args: any[]) => void): this
  off?(event: string, listener: (...args: any[]) => void): this
}

export type DesktopAgentDeviceStatus = {
  deviceId: string
  deviceName: string
  agentVersion: string
  capabilities: string[]
  connected: true
  connectedAtIso: string
  lastSeenAtIso: string
}

export type DesktopAgentRelayEvent = {
  deviceId: string
  event: unknown
}

type DesktopAgentRelayOptions = {
  authenticate: (deviceId: string, token: string) => boolean | Promise<boolean>
  requestTimeoutMs?: number
  heartbeatIntervalMs?: number
  heartbeatTimeoutMs?: number
  helloTimeoutMs?: number
  maxUnauthenticatedConnections?: number
  now?: () => number
}

type AgentConnection = {
  socket: AgentServerSocket
  deviceId: string
  deviceName: string
  agentVersion: string
  capabilities: string[]
  connectedAtMs: number
  lastSeenAtMs: number
  lastEventSequence: number
}

type PendingRequest = {
  deviceId: string
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timeout: ReturnType<typeof setTimeout>
}

type PendingResponseChunks = {
  deviceId: string
  total: number
  received: number
  bytes: number
  chunks: Array<Buffer | undefined>
}

export const DEFAULT_AGENT_REQUEST_TIMEOUT_MS = 90_000

export class DesktopAgentRelay {
  private readonly requestTimeoutMs: number
  private readonly heartbeatTimeoutMs: number
  private readonly helloTimeoutMs: number
  private readonly maxUnauthenticatedConnections: number
  private readonly now: () => number
  private readonly devices = new Map<string, AgentConnection>()
  private readonly connections = new Map<AgentServerSocket, AgentConnection | null>()
  private readonly helloTimers = new Map<AgentServerSocket, ReturnType<typeof setTimeout>>()
  private readonly authenticating = new Set<AgentServerSocket>()
  private readonly pending = new Map<string, PendingRequest>()
  private readonly responseChunks = new Map<string, PendingResponseChunks>()
  private readonly turnDevice = new Map<string, string>()
  private readonly eventListeners = new Set<(event: DesktopAgentRelayEvent) => void>()
  private readonly heartbeatTimer: ReturnType<typeof setInterval>
  private disposed = false

  constructor(private readonly options: DesktopAgentRelayOptions) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_AGENT_REQUEST_TIMEOUT_MS
    this.heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? 45_000
    this.helloTimeoutMs = options.helloTimeoutMs ?? 10_000
    this.maxUnauthenticatedConnections = options.maxUnauthenticatedConnections ?? 64
    this.now = options.now ?? Date.now
    this.heartbeatTimer = setInterval(
      () => this.sweepHeartbeat(),
      options.heartbeatIntervalMs ?? 15_000,
    )
    this.heartbeatTimer.unref?.()
  }

  accept(socket: AgentServerSocket, headers: { authorization?: string | string[] }): void {
    if (this.disposed) {
      socket.close(1012, 'Relay unavailable')
      return
    }
    const unauthenticatedCount = [...this.connections.values()].filter((connection) => connection === null).length
    if (unauthenticatedCount >= this.maxUnauthenticatedConnections) {
      socket.close(1013, 'Too many unauthenticated connections')
      return
    }
    const token = readBearerToken(headers.authorization)
    this.connections.set(socket, null)
    const helloTimer = setTimeout(() => {
      if (this.connections.get(socket) !== null) return
      socket.close(1008, 'Hello timed out')
      this.removeSocket(socket, new Error('Desktop agent hello timed out.'))
    }, this.helloTimeoutMs)
    helloTimer.unref?.()
    this.helloTimers.set(socket, helloTimer)
    socket.on('message', (raw: unknown) => {
      void this.handleMessage(socket, raw, token)
    })
    socket.on('close', () => this.removeSocket(socket, new Error('Desktop agent disconnected.')))
    socket.on('error', () => this.removeSocket(socket, new Error('Desktop agent connection failed.')))
  }

  listDevices(): DesktopAgentDeviceStatus[] {
    return [...this.devices.values()]
      .map((connection) => ({
        deviceId: connection.deviceId,
        deviceName: connection.deviceName,
        agentVersion: connection.agentVersion,
        capabilities: [...connection.capabilities],
        connected: true as const,
        connectedAtIso: new Date(connection.connectedAtMs).toISOString(),
        lastSeenAtIso: new Date(connection.lastSeenAtMs).toISOString(),
      }))
      .sort((first, second) => first.deviceName.localeCompare(second.deviceName))
  }

  subscribeEvents(listener: (event: DesktopAgentRelayEvent) => void): () => void {
    this.eventListeners.add(listener)
    return () => this.eventListeners.delete(listener)
  }

  async rpc<T = unknown>(method: string, params: unknown, deviceId?: string): Promise<T> {
    const selectedDeviceId = this.resolveDeviceId(method, params, deviceId)
    const result = await this.request(selectedDeviceId, 'rpc', { method, params }) as T
    if (method === 'turn/start') {
      const turnId = readTurnId(result)
      if (turnId) this.turnDevice.set(turnId, selectedDeviceId)
    }
    if (method === 'turn/interrupt') {
      const turnId = readString(asRecord(params)?.turnId)
      if (turnId) this.turnDevice.delete(turnId)
    }
    return result
  }

  async getBridgeStatus(deviceId?: string): Promise<unknown> {
    const selectedDeviceId = this.resolveDeviceId('bridge/status', null, deviceId)
    return this.request(selectedDeviceId, 'bridge/status', null)
  }

  sweepHeartbeat(): void {
    const now = this.now()
    for (const connection of [...this.devices.values()]) {
      if (now - connection.lastSeenAtMs > this.heartbeatTimeoutMs) {
        connection.socket.close(4001, 'Heartbeat timed out')
        continue
      }
      this.send(connection.socket, {
        version: AGENT_PROTOCOL_VERSION,
        type: 'ping',
        nonce: `hb:${now}`,
      })
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    clearInterval(this.heartbeatTimer)
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout)
      pending.reject(new Error('Desktop agent relay was disposed.'))
    }
    this.pending.clear()
    this.responseChunks.clear()
    for (const timer of this.helloTimers.values()) clearTimeout(timer)
    this.helloTimers.clear()
    this.authenticating.clear()
    for (const socket of [...this.connections.keys()]) {
      socket.close(1001, 'Server shutting down')
    }
    this.devices.clear()
    this.connections.clear()
    this.turnDevice.clear()
    this.eventListeners.clear()
  }

  private async handleMessage(socket: AgentServerSocket, raw: unknown, token: string): Promise<void> {
    let message: ReturnType<typeof decodeAgentMessage>
    try {
      message = decodeAgentMessage(raw)
    } catch (error) {
      console.warn(
        '[desktop-agent] rejected protocol frame:',
        error instanceof Error ? error.message : 'unknown protocol error',
      )
      this.rejectSocket(socket, 1008, 'Invalid protocol frame')
      return
    }

    if (!this.connections.has(socket)) return
    const connection = this.connections.get(socket)
    if (!connection) {
      if (message.type !== 'hello') {
        this.rejectSocket(socket, 1008, 'Hello required')
        return
      }
      if (this.authenticating.has(socket)) {
        this.rejectSocket(socket, 1008, 'Hello already in progress')
        return
      }
      this.authenticating.add(socket)
      try {
        await this.handleHello(socket, message, token)
      } finally {
        this.authenticating.delete(socket)
      }
      return
    }

    connection.lastSeenAtMs = this.now()
    if (message.type === 'response') {
      this.handleResponse(connection, message)
      return
    }
    if (message.type === 'response/chunk') {
      this.handleResponseChunk(connection, message)
      return
    }
    if (message.type === 'event') {
      if (message.sequence <= connection.lastEventSequence) return
      connection.lastEventSequence = message.sequence
      const event = { deviceId: connection.deviceId, event: message.event }
      for (const listener of this.eventListeners) listener(event)
      return
    }
    if (message.type === 'pong') return
    if (message.type === 'ping') {
      this.send(socket, { version: 1, type: 'pong', nonce: message.nonce })
    }
  }

  private async handleHello(socket: AgentServerSocket, hello: AgentHelloMessage, token: string): Promise<void> {
    let accepted = false
    try {
      accepted = Boolean(token) && await this.options.authenticate(hello.deviceId, token)
    } catch {
      accepted = false
    }
    if (!this.connections.has(socket) || socket.readyState !== WebSocket.OPEN) return
    this.clearHelloTimer(socket)
    if (!accepted) {
      this.send(socket, {
        version: 1,
        type: 'hello/ack',
        accepted: false,
        serverTimeIso: new Date(this.now()).toISOString(),
        error: 'Pairing token was rejected.',
      })
      this.rejectSocket(socket, 1008, 'Authentication rejected')
      return
    }

    const previous = this.devices.get(hello.deviceId)
    if (previous && previous.socket !== socket) previous.socket.close(4000, 'Replaced by a newer connection')
    const now = this.now()
    const connection: AgentConnection = {
      socket,
      deviceId: hello.deviceId,
      deviceName: hello.deviceName,
      agentVersion: hello.agentVersion,
      capabilities: [...hello.capabilities],
      connectedAtMs: now,
      lastSeenAtMs: now,
      lastEventSequence: 0,
    }
    this.connections.set(socket, connection)
    this.devices.set(connection.deviceId, connection)
    this.send(socket, {
      version: 1,
      type: 'hello/ack',
      accepted: true,
      serverTimeIso: new Date(now).toISOString(),
    })
  }

  private request(deviceId: string, method: 'rpc' | 'bridge/status', params: unknown): Promise<unknown> {
    const connection = this.devices.get(deviceId)
    if (!connection || connection.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error(`Desktop agent device ${deviceId} is offline.`))
    }
    const id = `req:${randomUUID()}`
    const promise = new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id)
        this.responseChunks.delete(id)
        reject(new Error(`Desktop agent request ${method} timed out after ${this.requestTimeoutMs}ms.`))
      }, this.requestTimeoutMs)
      timeout.unref?.()
      this.pending.set(id, { deviceId, resolve, reject, timeout })
    })
    this.send(connection.socket, { version: 1, type: 'request', id, method, params })
    return promise
  }

  private handleResponse(connection: AgentConnection, response: AgentResponseMessage): void {
    const pending = this.pending.get(response.id)
    if (!pending || pending.deviceId !== connection.deviceId) return
    clearTimeout(pending.timeout)
    this.pending.delete(response.id)
    this.responseChunks.delete(response.id)
    if (response.ok) pending.resolve(response.result)
    else pending.reject(new Error(response.error?.message ?? 'Desktop agent request failed.'))
  }

  private handleResponseChunk(connection: AgentConnection, chunk: AgentResponseChunkMessage): void {
    const pending = this.pending.get(chunk.id)
    if (!pending || pending.deviceId !== connection.deviceId) return
    let assembly = this.responseChunks.get(chunk.id)
    if (!assembly) {
      assembly = {
        deviceId: connection.deviceId,
        total: chunk.total,
        received: 0,
        bytes: 0,
        chunks: new Array<Buffer | undefined>(chunk.total),
      }
      this.responseChunks.set(chunk.id, assembly)
    }
    if (assembly.deviceId !== connection.deviceId || assembly.total !== chunk.total) {
      connection.socket.close(1008, 'Invalid response chunks')
      return
    }
    const decoded = Buffer.from(chunk.data, 'base64')
    const previous = assembly.chunks[chunk.index]
    if (previous) {
      if (!previous.equals(decoded)) connection.socket.close(1008, 'Conflicting response chunk')
      return
    }
    assembly.chunks[chunk.index] = decoded
    assembly.received += 1
    assembly.bytes += decoded.length
    if (assembly.bytes > MAX_AGENT_RESPONSE_BYTES) {
      connection.socket.close(1009, 'Response is too large')
      return
    }
    if (assembly.received !== assembly.total) return
    this.responseChunks.delete(chunk.id)
    try {
      const response = decodeReassembledAgentResponse(Buffer.concat(
        assembly.chunks as Buffer[],
        assembly.bytes,
      ))
      if (response.id !== chunk.id) throw new Error('Response id mismatch')
      this.handleResponse(connection, response)
    } catch {
      connection.socket.close(1008, 'Invalid reassembled response')
    }
  }

  private resolveDeviceId(method: string, params: unknown, requested?: string): string {
    const explicit = requested?.trim()
    if (explicit) {
      if (!this.devices.has(explicit)) throw new Error(`Desktop agent device ${explicit} is offline.`)
      return explicit
    }
    if (method === 'turn/interrupt') {
      const turnId = readString(asRecord(params)?.turnId)
      const routed = turnId ? this.turnDevice.get(turnId) : undefined
      if (routed && this.devices.has(routed)) return routed
    }
    if (this.devices.size === 1) return this.devices.keys().next().value as string
    if (this.devices.size === 0) throw new Error('No Desktop agent device is connected.')
    throw new Error('Multiple Desktop agent devices are connected; select a device.')
  }

  private removeSocket(socket: AgentServerSocket, error: Error): void {
    this.clearHelloTimer(socket)
    this.authenticating.delete(socket)
    const connection = this.connections.get(socket)
    this.connections.delete(socket)
    if (!connection) return
    if (this.devices.get(connection.deviceId)?.socket === socket) this.devices.delete(connection.deviceId)
    for (const [id, pending] of this.pending) {
      if (pending.deviceId !== connection.deviceId) continue
      clearTimeout(pending.timeout)
      this.pending.delete(id)
      this.responseChunks.delete(id)
      pending.reject(error)
    }
  }

  private clearHelloTimer(socket: AgentServerSocket): void {
    const timer = this.helloTimers.get(socket)
    if (timer) clearTimeout(timer)
    this.helloTimers.delete(socket)
  }

  private rejectSocket(socket: AgentServerSocket, code: number, reason: string): void {
    socket.close(code, reason)
    this.removeSocket(socket, new Error(reason))
  }

  private send(socket: AgentServerSocket, message: Parameters<typeof encodeAgentMessage>[0]): void {
    if (socket.readyState !== WebSocket.OPEN) return
    socket.send(encodeAgentMessage(message))
  }
}

export function createDesktopAgentTokenAuthenticator(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): (deviceId: string, token: string) => boolean {
  const globalHash = env.CODEXUI_AGENT_PAIRING_TOKEN
    ? hashToken(env.CODEXUI_AGENT_PAIRING_TOKEN)
    : ''
  const deviceHashes = new Map<string, string>()
  const rawMap = env.CODEXUI_AGENT_TOKENS_JSON?.trim()
  if (rawMap) {
    const parsed = JSON.parse(rawMap) as unknown
    const record = asRecord(parsed)
    if (!record) throw new Error('CODEXUI_AGENT_TOKENS_JSON must be a JSON object.')
    for (const [deviceId, value] of Object.entries(record)) {
      if (typeof value !== 'string' || !/^sha256:[a-f0-9]{64}$/iu.test(value)) {
        throw new Error('Desktop agent token map values must use sha256:<hex>.')
      }
      deviceHashes.set(deviceId, value.slice('sha256:'.length).toLowerCase())
    }
  }
  return (deviceId, token) => {
    const expected = deviceHashes.get(deviceId) ?? globalHash
    if (!expected || !token) return false
    return constantTimeHexEqual(expected, hashToken(token))
  }
}

function readBearerToken(value: string | string[] | undefined): string {
  const raw = Array.isArray(value) ? value[0] ?? '' : value ?? ''
  const match = raw.match(/^Bearer\s+(.+)$/iu)
  return match?.[1]?.trim() ?? ''
}

function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

function constantTimeHexEqual(first: string, second: string): boolean {
  if (first.length !== second.length) return false
  return timingSafeEqual(Buffer.from(first, 'hex'), Buffer.from(second, 'hex'))
}

function readTurnId(value: unknown): string {
  return readString(asRecord(asRecord(value)?.turn)?.id)
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}
