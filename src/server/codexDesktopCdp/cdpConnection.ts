import WebSocket from 'ws'
import type { CdpErrorPayload, CdpEvent } from './types'

export interface CdpSocketLike {
  readyState: number
  send(data: string): void
  close(): void
  on(event: string, listener: (...args: any[]) => void): this
  off?(event: string, listener: (...args: any[]) => void): this
}

type PendingRequest = {
  method: string
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timeout: ReturnType<typeof setTimeout>
}

type CdpResponse = {
  id?: number
  method?: string
  params?: unknown
  result?: unknown
  error?: CdpErrorPayload
}

export type CodexDesktopCdpConnectionOptions = {
  defaultTimeoutMs?: number
}

export class CodexDesktopCdpConnection {
  private readonly pending = new Map<number, PendingRequest>()
  private readonly eventListeners = new Set<(event: CdpEvent) => void>()
  private readonly closeListeners = new Set<(error: Error) => void>()
  private readonly defaultTimeoutMs: number
  private nextId = 0
  private closed = false
  private closeError: Error | null = null

  constructor(
    private readonly socket: CdpSocketLike,
    options: CodexDesktopCdpConnectionOptions = {},
  ) {
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 10_000
    socket.on('message', this.handleMessage)
    socket.on('close', this.handleClose)
    socket.on('error', this.handleError)
  }

  get pendingRequestCount(): number {
    return this.pending.size
  }

  call<T>(method: string, params?: unknown, options: { timeoutMs?: number } = {}): Promise<T> {
    if (this.closed || this.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('CDP connection is not open.'))
    }

    const id = ++this.nextId
    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs
    const promise = new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        const pending = this.pending.get(id)
        if (!pending) return
        this.pending.delete(id)
        pending.reject(new Error(`${method} timed out after ${timeoutMs}ms.`))
      }, timeoutMs)

      this.pending.set(id, {
        method,
        resolve: resolve as (value: unknown) => void,
        reject,
        timeout,
      })
    })

    try {
      this.socket.send(JSON.stringify({ id, method, ...(params === undefined ? {} : { params }) }))
    } catch (error) {
      const pending = this.pending.get(id)
      if (pending) {
        clearTimeout(pending.timeout)
        this.pending.delete(id)
        pending.reject(toError(error, `Failed to send ${method}.`))
      }
    }
    return promise
  }

  onEvent(listener: (event: CdpEvent) => void): () => void {
    this.eventListeners.add(listener)
    return () => {
      this.eventListeners.delete(listener)
    }
  }

  onClose(listener: (error: Error) => void): () => void {
    if (this.closeError) {
      listener(this.closeError)
      return () => undefined
    }
    this.closeListeners.add(listener)
    return () => {
      this.closeListeners.delete(listener)
    }
  }

  close(): void {
    if (this.closed) return
    this.socket.close()
    this.finishClose(new Error('CDP connection closed.'))
  }

  private readonly handleMessage = (raw: unknown): void => {
    let message: CdpResponse
    try {
      message = JSON.parse(readSocketText(raw)) as CdpResponse
    } catch {
      return
    }

    if (typeof message.id === 'number') {
      const pending = this.pending.get(message.id)
      if (!pending) return
      clearTimeout(pending.timeout)
      this.pending.delete(message.id)
      if (message.error) {
        pending.reject(new Error(`CDP ${pending.method} failed (${message.error.code}): ${message.error.message}`))
      } else {
        pending.resolve(message.result)
      }
      return
    }

    if (typeof message.method !== 'string') return
    const event: CdpEvent = {
      method: message.method,
      ...(message.params === undefined ? {} : { params: message.params }),
    }
    for (const listener of this.eventListeners) listener(event)
  }

  private readonly handleClose = (): void => {
    this.finishClose(new Error('CDP connection closed.'))
  }

  private readonly handleError = (error: unknown): void => {
    this.finishClose(toError(error, 'CDP connection failed.'))
  }

  private finishClose(error: Error): void {
    if (this.closed) return
    this.closed = true
    this.closeError = error
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout)
      pending.reject(error)
    }
    this.pending.clear()
    for (const listener of this.closeListeners) listener(error)
    this.closeListeners.clear()
    this.eventListeners.clear()
  }
}

export async function connectCodexDesktopCdp(
  url: string,
  options: CodexDesktopCdpConnectionOptions & {
    createSocket?: (url: string) => CdpSocketLike
    connectTimeoutMs?: number
  } = {},
): Promise<CodexDesktopCdpConnection> {
  const socket = options.createSocket?.(url) ?? new WebSocket(url)
  if (socket.readyState !== WebSocket.OPEN) {
    await waitForSocketOpen(socket, options.connectTimeoutMs ?? 5_000)
  }
  return new CodexDesktopCdpConnection(socket, options)
}

function waitForSocketOpen(socket: CdpSocketLike, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup()
      try {
        socket.close()
      } catch {
        // The timeout error below is authoritative.
      }
      reject(new Error(`CDP WebSocket connection timed out after ${timeoutMs}ms.`))
    }, timeoutMs)
    const onOpen = () => {
      cleanup()
      resolve()
    }
    const onError = (error: unknown) => {
      cleanup()
      reject(toError(error, 'CDP WebSocket connection failed.'))
    }
    const onClose = () => {
      cleanup()
      reject(new Error('CDP WebSocket closed before opening.'))
    }
    const cleanup = () => {
      clearTimeout(timeout)
      socket.off?.('open', onOpen)
      socket.off?.('error', onError)
      socket.off?.('close', onClose)
    }
    socket.on('open', onOpen)
    socket.on('error', onError)
    socket.on('close', onClose)
  })
}

function readSocketText(raw: unknown): string {
  if (typeof raw === 'string') return raw
  if (Buffer.isBuffer(raw)) return raw.toString('utf8')
  if (Array.isArray(raw)) return Buffer.concat(raw).toString('utf8')
  if (raw instanceof ArrayBuffer) return Buffer.from(raw).toString('utf8')
  return String(raw)
}

function toError(value: unknown, fallback: string): Error {
  return value instanceof Error ? value : new Error(typeof value === 'string' ? value : fallback)
}
