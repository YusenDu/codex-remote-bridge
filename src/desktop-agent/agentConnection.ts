import WebSocket from 'ws'
import type {
  DesktopBridgeEvent,
  DesktopBridgeStatus,
} from '../server/codexDesktopCdp/codexDesktopCdpBridge'
import {
  AGENT_PROTOCOL_VERSION,
  decodeAgentMessage,
  encodeAgentMessage,
  type AgentRequestMessage,
  type AgentResponseMessage,
} from './protocol'

export interface AgentClientSocket {
  readyState: number
  send(data: string): void
  close(code?: number, reason?: string): void
  on(event: string, listener: (...args: any[]) => void): this
  off?(event: string, listener: (...args: any[]) => void): this
}

export interface DesktopAgentBridge {
  rpc<T = unknown>(method: string, params: unknown): Promise<T>
  getStatus(): DesktopBridgeStatus
  subscribe(listener: (event: DesktopBridgeEvent) => void): () => void
}

export type DesktopAgentConnectionStatus = {
  state: 'stopped' | 'connecting' | 'authenticating' | 'connected' | 'error'
  serverUrl: string
  deviceId: string
  attempt: number
  connectedAtIso: string | null
  error: string | null
}

type DesktopAgentConnectionOptions = {
  serverUrl: string
  deviceId: string
  deviceName: string
  token: string
  agentVersion: string
  bridge: DesktopAgentBridge
  createSocket?: (url: string, options: { headers: { authorization: string } }) => AgentClientSocket
  reconnectDelaysMs?: number[]
}

export class DesktopAgentConnection {
  private readonly webSocketUrl: string
  private readonly reconnectDelaysMs: number[]
  private readonly createSocket: NonNullable<DesktopAgentConnectionOptions['createSocket']>
  private readonly listeners = new Set<(status: DesktopAgentConnectionStatus) => void>()
  private readonly completedResponses = new Map<string, string>()
  private readonly inFlightResponses = new Map<string, Promise<string>>()
  private socket: AgentClientSocket | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private unsubscribeBridge: (() => void) | null = null
  private stopped = true
  private authenticationRejected = false
  private eventSequence = 0
  private status: DesktopAgentConnectionStatus

  constructor(private readonly options: DesktopAgentConnectionOptions) {
    this.webSocketUrl = toAgentWebSocketUrl(options.serverUrl)
    this.reconnectDelaysMs = options.reconnectDelaysMs?.length
      ? options.reconnectDelaysMs.map((delay) => Math.max(0, delay))
      : [1_000, 2_000, 5_000, 10_000, 30_000]
    this.createSocket = options.createSocket ?? ((url, socketOptions) => (
      new WebSocket(url, socketOptions) as unknown as AgentClientSocket
    ))
    this.status = {
      state: 'stopped',
      serverUrl: redactServerUrl(options.serverUrl),
      deviceId: options.deviceId,
      attempt: 0,
      connectedAtIso: null,
      error: null,
    }
  }

  getStatus(): DesktopAgentConnectionStatus {
    return { ...this.status }
  }

  subscribe(listener: (status: DesktopAgentConnectionStatus) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  start(): void {
    if (!this.stopped) return
    this.stopped = false
    this.authenticationRejected = false
    this.unsubscribeBridge = this.options.bridge.subscribe((event) => this.sendBridgeEvent(event))
    this.connect()
  }

  stop(): void {
    if (this.stopped) return
    this.stopped = true
    this.authenticationRejected = false
    this.clearReconnectTimer()
    this.unsubscribeBridge?.()
    this.unsubscribeBridge = null
    const socket = this.socket
    this.socket = null
    if (socket && socket.readyState !== WebSocket.CLOSED) socket.close(1000, 'Agent stopped')
    this.updateStatus({
      state: 'stopped',
      attempt: 0,
      connectedAtIso: null,
      error: null,
    })
  }

  reconnect(): void {
    this.stop()
    this.start()
  }

  private connect(): void {
    if (this.stopped || this.socket) return
    this.clearReconnectTimer()
    const attempt = this.status.attempt + 1
    this.updateStatus({ state: 'connecting', attempt, error: null })
    let socket: AgentClientSocket
    try {
      socket = this.createSocket(this.webSocketUrl, {
        headers: { authorization: `Bearer ${this.options.token}` },
      })
    } catch (error) {
      this.updateStatus({ state: 'error', error: readErrorMessage(error) })
      this.scheduleReconnect()
      return
    }
    this.socket = socket
    socket.on('open', () => this.handleOpen(socket))
    socket.on('message', (raw: unknown) => this.handleMessage(socket, raw))
    socket.on('close', () => this.handleClose(socket))
    socket.on('error', (error: unknown) => this.handleSocketError(socket, error))
  }

  private handleOpen(socket: AgentClientSocket): void {
    if (socket !== this.socket || this.stopped) return
    this.updateStatus({ state: 'authenticating', error: null })
    this.send({
      version: AGENT_PROTOCOL_VERSION,
      type: 'hello',
      deviceId: this.options.deviceId,
      deviceName: this.options.deviceName,
      agentVersion: this.options.agentVersion,
      capabilities: ['rpc', 'events', 'bridge/status'],
    })
  }

  private handleMessage(socket: AgentClientSocket, raw: unknown): void {
    if (socket !== this.socket || this.stopped) return
    let message: ReturnType<typeof decodeAgentMessage>
    try {
      message = decodeAgentMessage(raw)
    } catch (error) {
      this.updateStatus({ state: 'error', error: readErrorMessage(error) })
      socket.close(1008, 'Invalid protocol frame')
      return
    }

    if (message.type === 'hello/ack') {
      if (!message.accepted) {
        this.authenticationRejected = true
        this.updateStatus({ state: 'error', error: message.error ?? 'Server rejected this device.' })
        socket.close(1008, 'Authentication rejected')
        return
      }
      this.updateStatus({
        state: 'connected',
        attempt: 0,
        connectedAtIso: new Date().toISOString(),
        error: null,
      })
      return
    }
    if (message.type === 'request') {
      this.executeRequest(message)
      return
    }
    if (message.type === 'ping') {
      this.send({ version: 1, type: 'pong', nonce: message.nonce })
    }
  }

  private executeRequest(request: AgentRequestMessage): void {
    const completed = this.completedResponses.get(request.id)
    if (completed) {
      this.sendEncoded(completed)
      return
    }
    const existing = this.inFlightResponses.get(request.id)
    if (existing) {
      void existing.then((encoded) => this.sendEncoded(encoded))
      return
    }

    const responsePromise = this.buildResponse(request).then((response) => encodeAgentMessage(response))
    this.inFlightResponses.set(request.id, responsePromise)
    void responsePromise.then((encoded) => {
      this.inFlightResponses.delete(request.id)
      this.rememberResponse(request.id, encoded)
      this.sendEncoded(encoded)
    })
  }

  private async buildResponse(request: AgentRequestMessage): Promise<AgentResponseMessage> {
    try {
      if (request.method === 'bridge/status') {
        return { version: 1, type: 'response', id: request.id, ok: true, result: this.options.bridge.getStatus() }
      }
      const params = asRecord(request.params)
      const method = typeof params?.method === 'string' ? params.method.trim() : ''
      if (!method) throw new Error('RPC request is missing method.')
      const result = await this.options.bridge.rpc(method, params?.params ?? null)
      return { version: 1, type: 'response', id: request.id, ok: true, result }
    } catch (error) {
      return {
        version: 1,
        type: 'response',
        id: request.id,
        ok: false,
        error: { code: 'RPC_FAILED', message: readErrorMessage(error) },
      }
    }
  }

  private sendBridgeEvent(event: DesktopBridgeEvent): void {
    if (this.status.state !== 'connected') return
    this.send({
      version: 1,
      type: 'event',
      sequence: ++this.eventSequence,
      event,
    })
  }

  private handleClose(socket: AgentClientSocket): void {
    if (socket !== this.socket) return
    this.socket = null
    if (this.stopped) return
    if (!this.authenticationRejected) {
      this.updateStatus({ state: 'error', connectedAtIso: null, error: this.status.error ?? 'Connection closed.' })
      this.scheduleReconnect()
    }
  }

  private handleSocketError(socket: AgentClientSocket, error: unknown): void {
    if (socket !== this.socket || this.stopped) return
    this.updateStatus({ state: 'error', error: readErrorMessage(error) })
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.authenticationRejected || this.reconnectTimer) return
    const index = Math.min(Math.max(this.status.attempt - 1, 0), this.reconnectDelaysMs.length - 1)
    const delay = this.reconnectDelaysMs[index] ?? 30_000
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect()
    }, delay)
    this.reconnectTimer.unref?.()
  }

  private clearReconnectTimer(): void {
    if (!this.reconnectTimer) return
    clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
  }

  private send(message: Parameters<typeof encodeAgentMessage>[0]): void {
    this.sendEncoded(encodeAgentMessage(message))
  }

  private sendEncoded(encoded: string): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return
    this.socket.send(encoded)
  }

  private rememberResponse(id: string, encoded: string): void {
    this.completedResponses.set(id, encoded)
    while (this.completedResponses.size > 512) {
      const oldest = this.completedResponses.keys().next().value
      if (typeof oldest !== 'string') break
      this.completedResponses.delete(oldest)
    }
  }

  private updateStatus(patch: Partial<DesktopAgentConnectionStatus>): void {
    this.status = { ...this.status, ...patch }
    for (const listener of this.listeners) listener(this.getStatus())
  }
}

export function toAgentWebSocketUrl(serverUrl: string): string {
  let url: URL
  try {
    url = new URL(serverUrl)
  } catch {
    throw new Error('Server URL is invalid.')
  }
  if (url.username || url.password) throw new Error('Server URL must not contain credentials.')
  if (url.protocol === 'https:') url.protocol = 'wss:'
  else if (url.protocol === 'http:') {
    if (!isLoopbackHost(url.hostname)) throw new Error('Remote agent servers must use HTTPS.')
    url.protocol = 'ws:'
  } else if (url.protocol === 'ws:') {
    if (!isLoopbackHost(url.hostname)) throw new Error('Remote agent servers must use HTTPS.')
  } else if (url.protocol !== 'wss:') {
    throw new Error('Server URL must use HTTPS.')
  }
  url.search = ''
  url.hash = ''
  url.pathname = `${url.pathname.replace(/\/+$/u, '')}/codex-api/agent/ws`.replace(/\/{2,}/gu, '/')
  return url.toString().replace(/\/$/u, '')
}

function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/gu, '')
  return normalized === 'localhost' || normalized === '::1' || /^127(?:\.\d{1,3}){3}$/u.test(normalized)
}

function redactServerUrl(serverUrl: string): string {
  try {
    const url = new URL(serverUrl)
    url.username = ''
    url.password = ''
    url.search = ''
    url.hash = ''
    return url.toString().replace(/\/$/u, '')
  } catch {
    return ''
  }
}

function readErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}
