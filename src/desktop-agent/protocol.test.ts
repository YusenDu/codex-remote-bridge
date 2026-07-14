import { describe, expect, it } from 'vitest'
import {
  AGENT_PROTOCOL_VERSION,
  MAX_AGENT_MESSAGE_BYTES,
  decodeReassembledAgentResponse,
  decodeAgentMessage,
  encodeAgentMessage,
} from './protocol'

describe('desktop agent protocol', () => {
  it('round-trips hello, RPC request, response, event, and heartbeat envelopes', () => {
    const messages = [
      {
        version: AGENT_PROTOCOL_VERSION,
        type: 'hello',
        deviceId: 'desktop-a',
        deviceName: 'Workstation',
        agentVersion: '0.1.87',
        capabilities: ['rpc', 'events'],
      },
      {
        version: AGENT_PROTOCOL_VERSION,
        type: 'request',
        id: 'req-1',
        method: 'rpc',
        params: { method: 'thread/list', params: { limit: 20 } },
      },
      {
        version: AGENT_PROTOCOL_VERSION,
        type: 'response',
        id: 'req-1',
        ok: true,
        result: { data: [] },
      },
      {
        version: AGENT_PROTOCOL_VERSION,
        type: 'event',
        sequence: 4,
        event: { protocol: 1, kind: 'notification', sequence: 9, payload: {} },
      },
      { version: AGENT_PROTOCOL_VERSION, type: 'ping', nonce: 'heartbeat-1' },
      { version: AGENT_PROTOCOL_VERSION, type: 'pong', nonce: 'heartbeat-1' },
    ] as const

    for (const message of messages) {
      expect(decodeAgentMessage(encodeAgentMessage(message))).toEqual(message)
    }
  })

  it('rejects unsupported versions and malformed request identities', () => {
    expect(() => decodeAgentMessage(JSON.stringify({
      version: 2,
      type: 'ping',
      nonce: 'n-1',
    }))).toThrow('version')
    expect(() => decodeAgentMessage(JSON.stringify({
      version: 1,
      type: 'request',
      id: '../bad',
      method: 'rpc',
      params: {},
    }))).toThrow('id')
    expect(() => decodeAgentMessage(JSON.stringify({
      version: 1,
      type: 'request',
      id: 'req-1',
      method: 'shell',
      params: {},
    }))).toThrow('method')
  })

  it('rejects oversized frames before JSON parsing', () => {
    const oversized = Buffer.alloc(MAX_AGENT_MESSAGE_BYTES + 1, 0x20)
    expect(() => decodeAgentMessage(oversized)).toThrow('too large')
  })

  it('validates response chunks and decodes a reassembled large response', () => {
    const chunk = {
      version: AGENT_PROTOCOL_VERSION,
      type: 'response/chunk',
      id: 'req-large',
      index: 0,
      total: 2,
      encoding: 'base64-json',
      data: Buffer.from('{"version":1').toString('base64'),
    } as const
    expect(decodeAgentMessage(encodeAgentMessage(chunk))).toEqual(chunk)

    const response = {
      version: AGENT_PROTOCOL_VERSION,
      type: 'response',
      id: 'req-large',
      ok: true,
      result: { text: 'x'.repeat(MAX_AGENT_MESSAGE_BYTES + 64) },
    } as const
    const payload = Buffer.from(JSON.stringify(response), 'utf8')
    expect(decodeReassembledAgentResponse(payload)).toEqual(response)

    expect(() => decodeAgentMessage(JSON.stringify({
      ...chunk,
      index: 2,
    }))).toThrow('chunk')
  })
})
