import {
  appendActiveDeviceId,
  type DeviceStorage,
} from '../api/deviceContext'

export function routeLocalImageUrl(
  value: string,
  threadId: string,
  storage?: DeviceStorage | null,
): string {
  const trimmed = value.trim()
  if (!trimmed.startsWith('/codex-local-image?')) return value

  const url = new URL(trimmed, 'http://localhost')
  if (url.pathname !== '/codex-local-image') return value
  if (url.searchParams.get('source') === 'server') return value

  url.searchParams.set('source', 'desktop')
  const normalizedThreadId = threadId.trim()
  if (normalizedThreadId) url.searchParams.set('threadId', normalizedThreadId)
  appendActiveDeviceId(url.searchParams, storage)
  return `${url.pathname}?${url.searchParams.toString()}`
}
