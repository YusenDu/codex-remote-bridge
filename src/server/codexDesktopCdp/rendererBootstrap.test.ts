import vm from 'node:vm'
import { describe, expect, it, vi } from 'vitest'
import {
  CODEX_DESKTOP_ADAPTER_GLOBAL,
  createRendererBootstrapSource,
} from './rendererBootstrap'

function createRendererFixture() {
  const sent: Array<{ method: string; params: unknown; options: unknown }> = []
  const notificationCallbacks: Array<(event: unknown) => void> = []
  const turnCallbacks: Array<(event: unknown) => void> = []
  const streamCallbacks: Array<(threadId: string, state: unknown) => void> = []
  const disposeSpies = [vi.fn(), vi.fn(), vi.fn()]
  const manager = {
    getHostId: () => 'local',
    getConversation: () => ({ id: 'thread-1' }),
    sendRequest: vi.fn(async (method: string, params: unknown, options: unknown) => {
      sent.push({ method, params, options })
      if (method === 'turn/start') return { turn: { id: 'turn-1', status: 'inProgress' } }
      return {}
    }),
    addNotificationCallback: vi.fn((_methods: string[], callback: (event: unknown) => void) => {
      notificationCallbacks.push(callback)
      return disposeSpies[0]
    }),
    addTurnCompletedListener: vi.fn((callback: (event: unknown) => void) => {
      turnCallbacks.push(callback)
      return disposeSpies[1]
    }),
    addStreamRoleStateCallback: vi.fn((callback: (threadId: string, state: unknown) => void) => {
      streamCallbacks.push(callback)
      return disposeSpies[2]
    }),
  }
  const fiber = {
    memoizedState: { memoizedState: manager, next: null },
    child: null,
    sibling: null,
  }
  const emitted: string[] = []
  const context: Record<string, unknown> = {
    __codexRoot: { _internalRoot: { current: fiber } },
    bridgeBinding: (payload: string) => emitted.push(payload),
    Date,
    JSON,
    Symbol,
    setTimeout,
    clearTimeout,
  }
  context.globalThis = context
  return { context, disposeSpies, emitted, manager, notificationCallbacks, sent, streamCallbacks, turnCallbacks }
}

describe('Codex Desktop renderer bootstrap', () => {
  it('resumes the Desktop app-server thread before starting a turn', async () => {
    const fixture = createRendererFixture()
    const handshake = await vm.runInNewContext(createRendererBootstrapSource('bridgeBinding'), fixture.context)
    const adapter = fixture.context[CODEX_DESKTOP_ADAPTER_GLOBAL] as {
      startTurn: (params: Record<string, unknown>) => Promise<unknown>
      interruptTurn: (params: { threadId: string; turnId: string }) => Promise<void>
      rpc: (method: string, params: unknown) => Promise<unknown>
    }

    await expect(adapter.startTurn({ threadId: 'thread-1', input: [{ type: 'text', text: 'hello' }] }))
      .resolves.toEqual({ turn: { id: 'turn-1', status: 'inProgress' } })
    await adapter.interruptTurn({ threadId: 'thread-1', turnId: 'turn-1' })
    await adapter.rpc('thread/list', { limit: 20 })

    expect(handshake).toMatchObject({ protocol: 1, hostId: 'local' })
    expect(fixture.sent).toEqual([
      {
        method: 'thread/resume',
        params: { threadId: 'thread-1' },
        options: { priority: 'critical' },
      },
      {
        method: 'turn/start',
        params: { threadId: 'thread-1', input: [{ type: 'text', text: 'hello' }] },
        options: { priority: 'critical' },
      },
      {
        method: 'turn/interrupt',
        params: { threadId: 'thread-1', turnId: 'turn-1' },
        options: { priority: 'critical' },
      },
      {
        method: 'thread/list',
        params: { limit: 20 },
        options: { priority: 'critical' },
      },
    ])
  })

  it('starts the first turn when a new Desktop thread has no rollout yet', async () => {
    const fixture = createRendererFixture()
    fixture.manager.sendRequest.mockImplementation(async (method: string, params: unknown, options: unknown) => {
      fixture.sent.push({ method, params, options })
      if (method === 'thread/resume') throw new Error('no rollout found for thread id thread-new')
      if (method === 'turn/start') return { turn: { id: 'turn-new', status: 'inProgress' } }
      return {}
    })
    await vm.runInNewContext(createRendererBootstrapSource('bridgeBinding'), fixture.context)
    const adapter = fixture.context[CODEX_DESKTOP_ADAPTER_GLOBAL] as {
      startTurn: (params: Record<string, unknown>) => Promise<unknown>
    }

    await expect(adapter.startTurn({ threadId: 'thread-new', input: [{ type: 'text', text: 'hello' }] }))
      .resolves.toEqual({ turn: { id: 'turn-new', status: 'inProgress' } })
    expect(fixture.sent.map(({ method }) => method)).toEqual(['thread/resume', 'turn/start'])
  })

  it('relays notifications and disposes an earlier bootstrap before reinstalling', async () => {
    const fixture = createRendererFixture()
    const source = createRendererBootstrapSource('bridgeBinding')
    await vm.runInNewContext(source, fixture.context)

    fixture.notificationCallbacks[0]({ method: 'turn/started', params: { threadId: 'thread-1' } })
    fixture.turnCallbacks[0]({ conversationId: 'thread-1', turnId: 'turn-1', status: 'completed' })
    fixture.streamCallbacks[0]('thread-1', { role: 'owner' })

    expect(fixture.emitted.map((payload) => JSON.parse(payload))).toMatchObject([
      { protocol: 1, kind: 'notification', payload: { method: 'turn/started' } },
      { protocol: 1, kind: 'turnCompleted', payload: { turnId: 'turn-1' } },
      { protocol: 1, kind: 'streamRole', payload: { threadId: 'thread-1' } },
    ])

    await vm.runInNewContext(source, fixture.context)
    expect(fixture.disposeSpies.every((dispose) => dispose.mock.calls.length === 1)).toBe(true)
  })

  it('fails closed on the wrong host and contains no global input automation', async () => {
    const fixture = createRendererFixture()
    fixture.manager.getHostId = () => 'remote'
    const source = createRendererBootstrapSource('bridgeBinding')

    await expect(vm.runInNewContext(source, fixture.context)).rejects.toThrow('local AppServerManager')
    expect(source).not.toMatch(/SendKeys|Clipboard|mouse_event|SetForegroundWindow|\.click\(/u)
  })
})
