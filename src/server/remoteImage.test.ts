import { describe, expect, it } from 'vitest'
import {
  MAX_REMOTE_IMAGE_BYTES,
  decodeRemoteImagePayload,
  payloadReferencesRemoteImagePath,
} from './remoteImage'

describe('remote desktop image helpers', () => {
  it('only authorizes paths present as exact strings in the thread payload', () => {
    const path = 'C:\\Users\\tester\\screenshot.png'
    const payload = { thread: { turns: [{ items: [{ content: [{ type: 'localImage', path }] }] }] } }

    expect(payloadReferencesRemoteImagePath(payload, path)).toBe(true)
    expect(payloadReferencesRemoteImagePath(payload, `${path}.bak`)).toBe(false)
  })

  it('decodes a bounded supported image response', () => {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    const decoded = decodeRemoteImagePayload({
      data: bytes.toString('base64'),
      contentType: 'image/png',
      size: bytes.length,
    })

    expect(decoded.contentType).toBe('image/png')
    expect(decoded.bytes).toEqual(bytes)
  })

  it('rejects malformed or oversized image responses', () => {
    expect(() => decodeRemoteImagePayload({
      data: Buffer.alloc(MAX_REMOTE_IMAGE_BYTES + 1).toString('base64'),
      contentType: 'image/png',
      size: MAX_REMOTE_IMAGE_BYTES + 1,
    })).toThrow('too large')
    expect(() => decodeRemoteImagePayload({
      data: 'not-base64',
      contentType: 'image/png',
      size: 4,
    })).toThrow('invalid')
  })
})
