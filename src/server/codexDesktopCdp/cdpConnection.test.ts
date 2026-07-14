import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { CodexDesktopCdpConnection, type CdpSocketLike } from './cdpConnection'

class FakeSocket extends EventEmitter implements CdpSocketLike {
  readyState = 1
  sent: string[] = []

  send(data: string): void {
    this.sent.push(data)
  }

  close(): void {
    this.readyState = 3
    this.emit('close', 1000, Buffer.from('closed'))
  }

  receive(value: unknown): void {
    this.emit('message', Buffer.from(JSON.stringify(value)))
  }
}

describe('CodexDesktopCdpConnection', () => {
  it('correlates out-of-order responses and emits protocol events', async () => {
    const socket = new FakeSocket()
    const connection = new CodexDesktopCdpConnection(socket)
    const events: unknown[] = []
    connection.onEvent((event) => events.push(event))

    const first = connection.call<{ value: number }>('Runtime.evaluate', { expression: '1' })
    const second = connection.call<{ value: number }>('Runtime.evaluate', { expression: '2' })
    const [firstRequest, secondRequest] = socket.sent.map((entry) => JSON.parse(entry) as { id: number })

    socket.receive({ method: 'Runtime.bindingCalled', params: { name: 'bridge', payload: '{}' } })
    socket.receive({ id: secondRequest.id, result: { value: 2 } })
    socket.receive({ id: firstRequest.id, result: { value: 1 } })

    await expect(first).resolves.toEqual({ value: 1 })
    await expect(second).resolves.toEqual({ value: 2 })
    expect(events).toEqual([
      { method: 'Runtime.bindingCalled', params: { name: 'bridge', payload: '{}' } },
    ])
  })

  it('rejects a CDP error without leaking other pending requests', async () => {
    const socket = new FakeSocket()
    const connection = new CodexDesktopCdpConnection(socket)
    const failed = connection.call('Runtime.evaluate')
    const succeeded = connection.call('Runtime.enable')
    const [failedRequest, succeededRequest] = socket.sent.map((entry) => JSON.parse(entry) as { id: number })

    socket.receive({ id: failedRequest.id, error: { code: -32000, message: 'evaluation failed' } })
    socket.receive({ id: succeededRequest.id, result: {} })

    await expect(failed).rejects.toThrow('evaluation failed')
    await expect(succeeded).resolves.toEqual({})
  })

  it('times out a request and ignores a late response', async () => {
    vi.useFakeTimers()
    try {
      const socket = new FakeSocket()
      const connection = new CodexDesktopCdpConnection(socket, { defaultTimeoutMs: 25 })
      const request = connection.call('Runtime.evaluate')
      const rejection = expect(request).rejects.toThrow('Runtime.evaluate timed out')
      const requestId = (JSON.parse(socket.sent[0]) as { id: number }).id

      await vi.advanceTimersByTimeAsync(26)
      await rejection
      socket.receive({ id: requestId, result: { ignored: true } })
      expect(connection.pendingRequestCount).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects every pending request when the socket closes', async () => {
    const socket = new FakeSocket()
    const connection = new CodexDesktopCdpConnection(socket)
    const closeListener = vi.fn()
    connection.onClose(closeListener)
    const first = connection.call('Runtime.evaluate')
    const second = connection.call('Runtime.enable')

    socket.close()
    socket.emit('error', new Error('late socket error'))

    await expect(first).rejects.toThrow('CDP connection closed')
    await expect(second).rejects.toThrow('CDP connection closed')
    expect(connection.pendingRequestCount).toBe(0)
    expect(closeListener).toHaveBeenCalledTimes(1)
    expect(closeListener).toHaveBeenCalledWith(expect.objectContaining({ message: 'CDP connection closed.' }))
  })

  it('immediately reports an already closed connection to late close subscribers', () => {
    const socket = new FakeSocket()
    const connection = new CodexDesktopCdpConnection(socket)
    socket.close()
    const closeListener = vi.fn()

    connection.onClose(closeListener)

    expect(closeListener).toHaveBeenCalledTimes(1)
  })
})
