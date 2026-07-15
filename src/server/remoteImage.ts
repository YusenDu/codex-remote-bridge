export const MAX_REMOTE_IMAGE_BYTES = 8 * 1024 * 1024

const REMOTE_IMAGE_CONTENT_TYPES = new Set([
  'image/avif',
  'image/bmp',
  'image/gif',
  'image/jpeg',
  'image/png',
  'image/webp',
])

type RemoteImagePayload = {
  bytes: Buffer
  contentType: string
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

export function payloadReferencesRemoteImagePath(payload: unknown, targetPath: string): boolean {
  if (!targetPath) return false
  const stack: unknown[] = [payload]
  const visited = new Set<object>()
  let inspected = 0

  while (stack.length > 0 && inspected < 200_000) {
    const current = stack.pop()
    inspected += 1
    if (typeof current === 'string') {
      if (current === targetPath) return true
      continue
    }
    if (!current || typeof current !== 'object') continue
    if (visited.has(current)) continue
    visited.add(current)
    if (Array.isArray(current)) {
      stack.push(...current)
    } else {
      stack.push(...Object.values(current))
    }
  }
  return false
}

export function decodeRemoteImagePayload(payload: unknown): RemoteImagePayload {
  const record = asRecord(payload)
  const data = typeof record?.data === 'string' ? record.data : ''
  const contentType = typeof record?.contentType === 'string' ? record.contentType : ''
  const size = typeof record?.size === 'number' ? record.size : -1
  if (!REMOTE_IMAGE_CONTENT_TYPES.has(contentType)) {
    throw new Error('Remote image content type is unsupported')
  }
  if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_REMOTE_IMAGE_BYTES) {
    throw new Error('Remote image is too large or has an invalid size')
  }
  const bytes = Buffer.from(data, 'base64')
  if (bytes.length !== size || bytes.toString('base64') !== data) {
    throw new Error('Remote image payload is invalid')
  }
  return { bytes, contentType }
}
