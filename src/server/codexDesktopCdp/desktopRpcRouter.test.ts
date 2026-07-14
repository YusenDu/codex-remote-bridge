import { describe, expect, it, vi } from 'vitest'
import {
  buildDesktopBridgeHealth,
  dispatchDesktopAgentRpc,
  dispatchDesktopAgentLocalOperation,
  dispatchDesktopCdpRpc,
  readDesktopBridgeMode,
  shouldUseLocalCodexAppServer,
  type DesktopCdpRpcBridge,
} from './desktopRpcRouter'

function createBridge(): DesktopCdpRpcBridge & {
  startTurn: ReturnType<typeof vi.fn>
  interruptTurn: ReturnType<typeof vi.fn>
} {
  return {
    startTurn: vi.fn().mockResolvedValue({ turn: { id: 'turn-real', status: 'inProgress' } }),
    interruptTurn: vi.fn().mockResolvedValue(undefined),
  }
}

describe('Desktop CDP RPC routing', () => {
  it('enables only the cdp mode and rejects legacy global-input modes', () => {
    expect(readDesktopBridgeMode({ CODEXUI_DESKTOP_DRIVER: 'cdp' })).toBe('cdp')
    expect(readDesktopBridgeMode({ CODEXUI_DESKTOP_DRIVER: 'agent' })).toBe('agent')
    expect(readDesktopBridgeMode({ CODEXUI_DESKTOP_DRIVER: 'off' })).toBe('off')
    expect(readDesktopBridgeMode({})).toBe('off')
    expect(() => readDesktopBridgeMode({ CODEXUI_DESKTOP_DRIVER: 'desktop-ui' })).toThrow('removed')
    expect(() => readDesktopBridgeMode({ CODEXUI_DESKTOP_DRIVER: 'sendkeys' })).toThrow('removed')
    expect(shouldUseLocalCodexAppServer('agent')).toBe(false)
    expect(shouldUseLocalCodexAppServer('cdp')).toBe(true)
    expect(shouldUseLocalCodexAppServer('off')).toBe(true)
  })

  it('routes turn/start with the original app-server params', async () => {
    const bridge = createBridge()
    const params = {
      threadId: 'thread-1',
      input: [{ type: 'text', text: 'hello' }],
      model: 'gpt-5.5',
    }

    await expect(dispatchDesktopCdpRpc('turn/start', params, bridge)).resolves.toEqual({
      handled: true,
      result: { turn: { id: 'turn-real', status: 'inProgress' } },
    })
    expect(bridge.startTurn).toHaveBeenCalledWith(params)
  })

  it('routes turn/interrupt and rejects missing turn identity', async () => {
    const bridge = createBridge()

    await expect(dispatchDesktopCdpRpc('turn/interrupt', {
      threadId: 'thread-1',
      turnId: 'turn-real',
    }, bridge)).resolves.toEqual({ handled: true, result: {} })
    expect(bridge.interruptTurn).toHaveBeenCalledWith({ threadId: 'thread-1', turnId: 'turn-real' })

    await expect(dispatchDesktopCdpRpc('turn/interrupt', {
      threadId: 'thread-1',
    }, bridge)).rejects.toThrow('threadId and turnId')
  })

  it('leaves unrelated RPC methods on the local app-server path', async () => {
    const bridge = createBridge()
    await expect(dispatchDesktopCdpRpc('thread/read', { threadId: 'thread-1' }, bridge))
      .resolves.toEqual({ handled: false })
    expect(bridge.startTurn).not.toHaveBeenCalled()
    expect(bridge.interruptTurn).not.toHaveBeenCalled()
  })

  it('builds a read-only health payload without exposing a debugger endpoint', () => {
    const health = buildDesktopBridgeHealth('cdp', {
      state: 'ready',
      processId: 40972,
      appVersion: '26.707.3748.0',
      protocol: 1,
      handshakeFingerprint: '0123456789abcdef',
      connectedAtIso: '2026-07-10T09:00:00.000Z',
      error: null,
    })

    expect(health).toEqual({
      enabled: true,
      mode: 'cdp',
      state: 'ready',
      processId: 40972,
      appVersion: '26.707.3748.0',
      protocol: 1,
      handshakeFingerprint: '0123456789abcdef',
      connectedAtIso: '2026-07-10T09:00:00.000Z',
      error: null,
    })
    expect(JSON.stringify(health)).not.toMatch(/webSocket|debugger/iu)
  })

  it('reports a connected Desktop agent as ready', () => {
    const status = {
      state: 'disconnected' as const,
      processId: null,
      appVersion: null,
      protocol: null,
      handshakeFingerprint: null,
      connectedAtIso: null,
      error: null,
    }

    expect(buildDesktopBridgeHealth('agent', status, 1).state).toBe('ready')
    expect(buildDesktopBridgeHealth('agent', status, 0).state).toBe('disconnected')
  })

  it('routes every app-server RPC through a connected Desktop agent', async () => {
    const relay = { rpc: vi.fn().mockResolvedValue({ data: [] }) }

    await expect(dispatchDesktopAgentRpc('thread/list', { limit: 20 }, relay, 'desktop-a'))
      .resolves.toEqual({ handled: true, result: { data: [] } })
    expect(relay.rpc).toHaveBeenCalledWith('thread/list', { limit: 20 }, 'desktop-a')
  })

  it('routes local filesystem operations only in agent mode', async () => {
    const relay = { rpc: vi.fn().mockResolvedValue({ name: 'New Project (1)' }) }

    await expect(dispatchDesktopAgentLocalOperation(
      'agent',
      'project-root-suggestion',
      { basePath: 'K:\\projects' },
      relay,
      'desktop-a',
    )).resolves.toEqual({ handled: true, result: { name: 'New Project (1)' } })
    expect(relay.rpc).toHaveBeenCalledWith(
      'codex-web/local/project-root-suggestion',
      { basePath: 'K:\\projects' },
      'desktop-a',
    )

    await expect(dispatchDesktopAgentLocalOperation(
      'off',
      'project-root-suggestion',
      { basePath: 'K:\\projects' },
      relay,
      'desktop-a',
    )).resolves.toEqual({ handled: false })
  })
})
