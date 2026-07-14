export const AGENT_PROTOCOL_VERSION = 1 as const
export const MAX_AGENT_MESSAGE_BYTES = 1024 * 1024
export const AGENT_RESPONSE_CHUNK_BYTES = 512 * 1024
export const MAX_AGENT_RESPONSE_BYTES = 256 * 1024 * 1024
export const MAX_AGENT_RESPONSE_CHUNKS = MAX_AGENT_RESPONSE_BYTES / AGENT_RESPONSE_CHUNK_BYTES

const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u
const ALLOWED_REQUEST_METHODS = new Set(['rpc', 'bridge/status'])

export type AgentHelloMessage = {
  version: 1
  type: 'hello'
  deviceId: string
  deviceName: string
  agentVersion: string
  capabilities: readonly string[]
}

export type AgentHelloAckMessage = {
  version: 1
  type: 'hello/ack'
  accepted: boolean
  serverTimeIso: string
  error?: string
}

export type AgentRequestMessage = {
  version: 1
  type: 'request'
  id: string
  method: 'rpc' | 'bridge/status'
  params: unknown
}

export type AgentResponseMessage = {
  version: 1
  type: 'response'
  id: string
  ok: boolean
  result?: unknown
  error?: { code: string; message: string }
}

export type AgentResponseChunkMessage = {
  version: 1
  type: 'response/chunk'
  id: string
  index: number
  total: number
  encoding: 'base64-json'
  data: string
}

export type AgentEventMessage = {
  version: 1
  type: 'event'
  sequence: number
  event: unknown
}

export type AgentHeartbeatMessage = {
  version: 1
  type: 'ping' | 'pong'
  nonce: string
}

export type DesktopAgentMessage =
  | AgentHelloMessage
  | AgentHelloAckMessage
  | AgentRequestMessage
  | AgentResponseMessage
  | AgentResponseChunkMessage
  | AgentEventMessage
  | AgentHeartbeatMessage

export function encodeAgentMessage(message: DesktopAgentMessage): string {
  const encoded = JSON.stringify(message)
  if (Buffer.byteLength(encoded, 'utf8') > MAX_AGENT_MESSAGE_BYTES) {
    throw new Error('Desktop agent message is too large.')
  }
  return encoded
}

export function decodeAgentMessage(raw: unknown): DesktopAgentMessage {
  const text = readFrameText(raw)
  if (Buffer.byteLength(text, 'utf8') > MAX_AGENT_MESSAGE_BYTES) {
    throw new Error('Desktop agent message is too large.')
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('Desktop agent message is not valid JSON.')
  }
  const record = asRecord(parsed)
  if (!record) throw new Error('Desktop agent message must be an object.')
  if (record.version !== AGENT_PROTOCOL_VERSION) {
    throw new Error('Desktop agent protocol version is unsupported.')
  }

  switch (record.type) {
    case 'hello':
      return parseHello(record)
    case 'hello/ack':
      return parseHelloAck(record)
    case 'request':
      return parseRequest(record)
    case 'response':
      return parseResponse(record)
    case 'response/chunk':
      return parseResponseChunk(record)
    case 'event':
      return parseEvent(record)
    case 'ping':
    case 'pong':
      return {
        version: 1,
        type: record.type,
        nonce: readSafeId(record.nonce, 'heartbeat nonce'),
      }
    default:
      throw new Error('Desktop agent message type is unsupported.')
  }
}

export function decodeReassembledAgentResponse(raw: Uint8Array): AgentResponseMessage {
  if (raw.byteLength > MAX_AGENT_RESPONSE_BYTES) {
    throw new Error('Desktop agent response is too large.')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(raw).toString('utf8'))
  } catch {
    throw new Error('Desktop agent response is not valid JSON.')
  }
  const record = asRecord(parsed)
  if (!record || record.version !== AGENT_PROTOCOL_VERSION || record.type !== 'response') {
    throw new Error('Desktop agent reassembled response is invalid.')
  }
  return parseResponse(record)
}

function parseHello(record: Record<string, unknown>): AgentHelloMessage {
  const capabilities = Array.isArray(record.capabilities)
    ? record.capabilities.filter((value): value is string => typeof value === 'string')
    : []
  if (capabilities.length === 0 || capabilities.length > 32) {
    throw new Error('Desktop agent hello capabilities are invalid.')
  }
  return {
    version: 1,
    type: 'hello',
    deviceId: readSafeId(record.deviceId, 'device id'),
    deviceName: readBoundedText(record.deviceName, 'device name', 160),
    agentVersion: readBoundedText(record.agentVersion, 'agent version', 80),
    capabilities: [...new Set(capabilities.map((value) => readBoundedText(value, 'capability', 80)))],
  }
}

function parseHelloAck(record: Record<string, unknown>): AgentHelloAckMessage {
  if (typeof record.accepted !== 'boolean') throw new Error('Desktop agent hello acknowledgement is invalid.')
  return {
    version: 1,
    type: 'hello/ack',
    accepted: record.accepted,
    serverTimeIso: readBoundedText(record.serverTimeIso, 'server time', 80),
    ...(typeof record.error === 'string' && record.error ? { error: record.error.slice(0, 500) } : {}),
  }
}

function parseRequest(record: Record<string, unknown>): AgentRequestMessage {
  const method = typeof record.method === 'string' ? record.method : ''
  if (!ALLOWED_REQUEST_METHODS.has(method)) throw new Error('Desktop agent request method is unsupported.')
  return {
    version: 1,
    type: 'request',
    id: readSafeId(record.id, 'request id'),
    method: method as AgentRequestMessage['method'],
    params: record.params ?? null,
  }
}

function parseResponse(record: Record<string, unknown>): AgentResponseMessage {
  if (typeof record.ok !== 'boolean') throw new Error('Desktop agent response status is invalid.')
  const error = asRecord(record.error)
  return {
    version: 1,
    type: 'response',
    id: readSafeId(record.id, 'response id'),
    ok: record.ok,
    ...(Object.prototype.hasOwnProperty.call(record, 'result') ? { result: record.result } : {}),
    ...(error
      ? {
          error: {
            code: readBoundedText(error.code, 'response error code', 80),
            message: readBoundedText(error.message, 'response error message', 1_000),
          },
        }
      : {}),
  }
}

function parseResponseChunk(record: Record<string, unknown>): AgentResponseChunkMessage {
  const index = readBoundedInteger(record.index, 0, MAX_AGENT_RESPONSE_CHUNKS - 1, 'chunk index')
  const total = readBoundedInteger(record.total, 1, MAX_AGENT_RESPONSE_CHUNKS, 'chunk total')
  if (index >= total || record.encoding !== 'base64-json') {
    throw new Error('Desktop agent response chunk is invalid.')
  }
  const data = typeof record.data === 'string' ? record.data : ''
  const maxBase64Length = Math.ceil(AGENT_RESPONSE_CHUNK_BYTES / 3) * 4
  if (!data || data.length > maxBase64Length || !/^[A-Za-z0-9+/]+={0,2}$/u.test(data)) {
    throw new Error('Desktop agent response chunk data is invalid.')
  }
  const decoded = Buffer.from(data, 'base64')
  if (decoded.length === 0 || decoded.length > AGENT_RESPONSE_CHUNK_BYTES || decoded.toString('base64') !== data) {
    throw new Error('Desktop agent response chunk data is invalid.')
  }
  return {
    version: 1,
    type: 'response/chunk',
    id: readSafeId(record.id, 'response id'),
    index,
    total,
    encoding: 'base64-json',
    data,
  }
}

function parseEvent(record: Record<string, unknown>): AgentEventMessage {
  if (!Number.isSafeInteger(record.sequence) || Number(record.sequence) < 1) {
    throw new Error('Desktop agent event sequence is invalid.')
  }
  return {
    version: 1,
    type: 'event',
    sequence: Number(record.sequence),
    event: record.event ?? null,
  }
}

function readSafeId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !SAFE_ID_PATTERN.test(value)) {
    throw new Error(`Desktop agent ${label} is invalid.`)
  }
  return value
}

function readBoundedText(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== 'string') throw new Error(`Desktop agent ${label} is invalid.`)
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > maxLength) throw new Error(`Desktop agent ${label} is invalid.`)
  return trimmed
}

function readBoundedInteger(value: unknown, min: number, max: number, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) {
    throw new Error(`Desktop agent ${label} is invalid.`)
  }
  return Number(value)
}

function readFrameText(raw: unknown): string {
  if (typeof raw === 'string') return raw
  if (Buffer.isBuffer(raw)) return raw.toString('utf8')
  if (Array.isArray(raw)) return Buffer.concat(raw).toString('utf8')
  if (raw instanceof ArrayBuffer) return Buffer.from(raw).toString('utf8')
  return String(raw)
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}
