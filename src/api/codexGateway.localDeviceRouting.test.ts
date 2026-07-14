import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getGitBranchState, getProjectRootSuggestion, getWorktreeBranchOptions } from './codexGateway'
import { clearActiveDeviceId, setActiveDeviceId } from './deviceContext'

class MemoryStorage {
  private readonly values = new Map<string, string>()
  getItem(key: string): string | null { return this.values.get(key) ?? null }
  setItem(key: string, value: string): void { this.values.set(key, value) }
  removeItem(key: string): void { this.values.delete(key) }
}

const originalWindow = globalThis.window
const originalFetch = globalThis.fetch

describe('local API device routing', () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { localStorage: new MemoryStorage() },
    })
    setActiveDeviceId('desktop-a')
  })

  afterEach(() => {
    clearActiveDeviceId()
    vi.restoreAllMocks()
    Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow })
    Object.defineProperty(globalThis, 'fetch', { configurable: true, value: originalFetch })
  })

  it('includes the selected device in filesystem and Git requests', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      const data = url.includes('project-root-suggestion')
        ? { name: 'New Project (1)', path: 'K:\\New Project (1)' }
        : url.includes('worktree/branches')
          ? []
          : { currentBranch: null, options: [] }
      return new Response(JSON.stringify({ data }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    })
    Object.defineProperty(globalThis, 'fetch', { configurable: true, value: fetchMock })

    await getProjectRootSuggestion('K:\\')
    await getWorktreeBranchOptions('K:\\project')
    await getGitBranchState('K:\\project')

    expect(fetchMock.mock.calls.map(([input]) => new URL(String(input), 'https://example.test').searchParams.get('deviceId')))
      .toEqual(['desktop-a', 'desktop-a', 'desktop-a'])
  })
})
