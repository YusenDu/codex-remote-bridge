import { createHash, randomBytes } from 'node:crypto'
import { connectCodexDesktopCdp } from './cdpConnection'
import {
  CODEX_DESKTOP_ADAPTER_PROTOCOL,
  createRendererBootstrapSource,
  createRendererCommandSource,
  createRendererDisposeSource,
} from './rendererBootstrap'
import { discoverCodexDesktopRenderer } from './windowsDiscovery'
import type { CdpEvent, CodexRendererTarget } from './types'

type RuntimeEvaluateResponse = {
  result?: {
    type?: string
    value?: unknown
    description?: string
  }
  exceptionDetails?: {
    text?: string
    exception?: { description?: string }
  }
}

type RendererHandshake = {
  protocol: number
  hostId: string
  capabilities: string[]
  rendererUrl?: string
}

export type DesktopBridgeEvent = {
  protocol: 1
  kind: 'notification' | 'turnCompleted' | 'streamRole' | 'conversationState'
  sequence: number
  payload: unknown
}

export type DesktopBridgeStatus = {
  state: 'disconnected' | 'connecting' | 'ready' | 'error'
  processId: number | null
  appVersion: string | null
  protocol: number | null
  handshakeFingerprint: string | null
  connectedAtIso: string | null
  error: string | null
}

export interface CdpBridgeClient {
  call<T>(method: string, params?: unknown, options?: { timeoutMs?: number }): Promise<T>
  onEvent(listener: (event: CdpEvent) => void): () => void
  onClose(listener: (error: Error) => void): () => void
  close(): void | Promise<void>
}

type CodexDesktopCdpBridgeDependencies = {
  discover?: () => Promise<CodexRendererTarget>
  connect?: (url: string) => Promise<CdpBridgeClient>
  bindingName?: string
  reconnectDelaysMs?: number[]
}

export class CodexDesktopCdpBridge {
  readonly bindingName: string

  private readonly discoverTarget: () => Promise<CodexRendererTarget>
  private readonly connectClient: (url: string) => Promise<CdpBridgeClient>
  private readonly reconnectDelaysMs: number[]
  private readonly listeners = new Set<(event: DesktopBridgeEvent) => void>()
  private client: CdpBridgeClient | null = null
  private target: CodexRendererTarget | null = null
  private removeCdpEventListener: (() => void) | null = null
  private removeCdpCloseListener: (() => void) | null = null
  private connectionPromise: Promise<void> | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectAttempt = 0
  private keepAlive = false
  private disposed = false
  private status: DesktopBridgeStatus = {
    state: 'disconnected',
    processId: null,
    appVersion: null,
    protocol: null,
    handshakeFingerprint: null,
    connectedAtIso: null,
    error: null,
  }

  constructor(dependencies: CodexDesktopCdpBridgeDependencies = {}) {
    this.discoverTarget = dependencies.discover ?? discoverCodexDesktopRenderer
    this.connectClient = dependencies.connect
      ?? ((url) => connectCodexDesktopCdp(url))
    this.bindingName = dependencies.bindingName
      ?? `__codexMobileCdpEvent_${process.pid}_${randomBytes(6).toString('hex')}`
    this.reconnectDelaysMs = dependencies.reconnectDelaysMs?.length
      ? dependencies.reconnectDelaysMs.map((delay) => Math.max(0, delay))
      : [1_000, 2_000, 5_000, 10_000, 30_000]
  }

  getStatus(): DesktopBridgeStatus {
    return { ...this.status }
  }

  subscribe(listener: (event: DesktopBridgeEvent) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  start(): void {
    if (this.disposed) throw new Error('Codex Desktop CDP bridge is disposed.')
    this.keepAlive = true
    this.connectInBackground()
  }

  async connect(): Promise<void> {
    if (this.disposed) throw new Error('Codex Desktop CDP bridge is disposed.')
    if (this.status.state === 'ready' && this.client) return
    if (this.connectionPromise) return this.connectionPromise
    this.clearReconnectTimer()

    this.status = { ...this.status, state: 'connecting', error: null }
    this.connectionPromise = this.openAndHandshake()
    try {
      await this.connectionPromise
      this.reconnectAttempt = 0
    } catch (error) {
      if (this.keepAlive) this.scheduleReconnect()
      throw error
    } finally {
      this.connectionPromise = null
    }
  }

  async startTurn(params: Record<string, unknown>): Promise<{ turn: { id: string; status?: string } }> {
    await this.connect()
    const result = await this.evaluate<unknown>(createRendererCommandSource('startTurn', params), 30_000)
    const record = asRecord(result)
    const turn = asRecord(record?.turn)
    const turnId = typeof turn?.id === 'string' ? turn.id.trim() : ''
    if (!turnId) throw new Error('Codex Desktop turn/start did not return a real turn id.')
    return {
      turn: {
        id: turnId,
        ...(typeof turn?.status === 'string' ? { status: turn.status } : {}),
      },
    }
  }

  async rpc<T = unknown>(method: string, params: unknown): Promise<T> {
    const normalizedMethod = method.trim()
    if (!/^[A-Za-z0-9._/-]{1,160}$/u.test(normalizedMethod)) {
      throw new Error('Codex Desktop RPC method is invalid.')
    }
    await this.connect()
    return this.evaluate<T>(createRendererCommandSource('rpc', {
      method: normalizedMethod,
      params,
    }), 30_000)
  }

  async interruptTurn(params: { threadId: string; turnId: string }): Promise<void> {
    await this.connect()
    await this.evaluate(createRendererCommandSource('interruptTurn', params), 15_000)
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.keepAlive = false
    this.clearReconnectTimer()
    const client = this.client
    this.client = null
    this.removeCdpEventListener?.()
    this.removeCdpEventListener = null
    this.removeCdpCloseListener?.()
    this.removeCdpCloseListener = null
    if (client) {
      try {
        await this.evaluateWithClient(client, createRendererDisposeSource(), 2_000)
      } catch {
        // Renderer teardown is best-effort; the CDP socket is closed below.
      }
      await client.close()
    }
    this.status = {
      state: 'disconnected',
      processId: null,
      appVersion: null,
      protocol: null,
      handshakeFingerprint: null,
      connectedAtIso: null,
      error: null,
    }
  }

  private async openAndHandshake(): Promise<void> {
    let client: CdpBridgeClient | null = null
    try {
      const target = await this.discoverTarget()
      client = await this.connectClient(target.webSocketDebuggerUrl)
      this.removeCdpEventListener = client.onEvent(this.handleCdpEvent)
      await client.call('Runtime.enable')
      await client.call('Runtime.addBinding', { name: this.bindingName })
      const handshake = await this.evaluateWithClient<unknown>(
        client,
        createRendererBootstrapSource(this.bindingName),
        10_000,
      )
      validateHandshake(handshake)
      this.client = client
      this.target = target
      this.status = {
        state: 'ready',
        processId: target.processId,
        appVersion: target.appVersion,
        protocol: handshake.protocol,
        handshakeFingerprint: fingerprintHandshake(handshake),
        connectedAtIso: new Date().toISOString(),
        error: null,
      }
      const removeCloseListener = client.onClose((error) => {
        this.handleClientClose(client!, error)
      })
      if (this.client === client) this.removeCdpCloseListener = removeCloseListener
      else removeCloseListener()
    } catch (error) {
      this.removeCdpEventListener?.()
      this.removeCdpEventListener = null
      this.removeCdpCloseListener?.()
      this.removeCdpCloseListener = null
      if (this.client === client) this.client = null
      if (client) await client.close()
      const normalized = error instanceof Error ? error : new Error(String(error))
      this.status = {
        state: 'error',
        processId: this.target?.processId ?? null,
        appVersion: this.target?.appVersion ?? null,
        protocol: this.status.protocol,
        handshakeFingerprint: this.status.handshakeFingerprint,
        connectedAtIso: this.status.connectedAtIso,
        error: normalized.message,
      }
      throw normalized
    }
  }

  private async evaluate<T>(expression: string, timeoutMs: number): Promise<T> {
    if (!this.client) throw new Error('Codex Desktop CDP bridge is not connected.')
    return this.evaluateWithClient<T>(this.client, expression, timeoutMs)
  }

  private async evaluateWithClient<T>(
    client: CdpBridgeClient,
    expression: string,
    timeoutMs: number,
  ): Promise<T> {
    const response = await client.call<RuntimeEvaluateResponse>('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    }, { timeoutMs })
    if (response.exceptionDetails) {
      throw new Error(
        response.exceptionDetails.exception?.description
          ?? response.exceptionDetails.text
          ?? 'Codex Desktop renderer evaluation failed.',
      )
    }
    return response.result?.value as T
  }

  private readonly handleCdpEvent = (event: CdpEvent): void => {
    if (event.method !== 'Runtime.bindingCalled') return
    const params = asRecord(event.params)
    if (params?.name !== this.bindingName || typeof params.payload !== 'string') return
    let value: unknown
    try {
      value = JSON.parse(params.payload)
    } catch {
      return
    }
    const parsed = parseDesktopBridgeEvent(value)
    if (!parsed) return
    for (const listener of this.listeners) listener(parsed)
  }

  private handleClientClose(client: CdpBridgeClient, error: Error): void {
    if (this.client !== client || this.disposed) return
    this.client = null
    this.removeCdpEventListener?.()
    this.removeCdpEventListener = null
    this.removeCdpCloseListener?.()
    this.removeCdpCloseListener = null
    this.status = {
      state: 'disconnected',
      processId: this.target?.processId ?? null,
      appVersion: this.target?.appVersion ?? null,
      protocol: this.status.protocol,
      handshakeFingerprint: this.status.handshakeFingerprint,
      connectedAtIso: this.status.connectedAtIso,
      error: error.message,
    }
    if (this.keepAlive) this.scheduleReconnect()
  }

  private connectInBackground(): void {
    if (this.disposed || !this.keepAlive || this.connectionPromise || this.client) return
    void this.connect().catch(() => {
      // connect() updates status and schedules the next retry.
    })
  }

  private scheduleReconnect(): void {
    if (this.disposed || !this.keepAlive || this.reconnectTimer) return
    const delayIndex = Math.min(this.reconnectAttempt, this.reconnectDelaysMs.length - 1)
    const delayMs = this.reconnectDelaysMs[delayIndex] ?? 30_000
    this.reconnectAttempt += 1
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connectInBackground()
    }, delayMs)
    this.reconnectTimer.unref?.()
  }

  private clearReconnectTimer(): void {
    if (!this.reconnectTimer) return
    clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
  }
}

function validateHandshake(value: unknown): asserts value is RendererHandshake {
  const record = asRecord(value)
  if (record?.protocol !== CODEX_DESKTOP_ADAPTER_PROTOCOL) {
    throw new Error('Codex Desktop CDP adapter protocol is incompatible.')
  }
  if (record.hostId !== 'local') {
    throw new Error('Codex Desktop CDP adapter did not resolve the local host.')
  }
  const capabilities = Array.isArray(record.capabilities)
    ? record.capabilities.filter((entry): entry is string => typeof entry === 'string')
    : []
  for (const capability of ['rpc', 'turn/start', 'turn/interrupt', 'events']) {
    if (!capabilities.includes(capability)) {
      throw new Error(`Codex Desktop CDP adapter is missing capability ${capability}.`)
    }
  }
}

function fingerprintHandshake(handshake: RendererHandshake): string {
  const value = JSON.stringify({
    protocol: handshake.protocol,
    hostId: handshake.hostId,
    capabilities: [...handshake.capabilities].sort(),
    rendererUrl: handshake.rendererUrl ?? 'app://-/index.html',
  })
  return createHash('sha256').update(value).digest('hex').slice(0, 16)
}

function parseDesktopBridgeEvent(value: unknown): DesktopBridgeEvent | null {
  const record = asRecord(value)
  if (record?.protocol !== CODEX_DESKTOP_ADAPTER_PROTOCOL) return null
  if (!['notification', 'turnCompleted', 'streamRole', 'conversationState'].includes(String(record.kind))) {
    return null
  }
  if (typeof record.sequence !== 'number' || !Number.isSafeInteger(record.sequence) || record.sequence < 1) {
    return null
  }
  return {
    protocol: 1,
    kind: record.kind as DesktopBridgeEvent['kind'],
    sequence: record.sequence,
    payload: record.payload,
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : null
}
