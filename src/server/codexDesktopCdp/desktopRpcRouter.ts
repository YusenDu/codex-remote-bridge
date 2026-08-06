import type { DesktopBridgeStatus } from './codexDesktopCdpBridge'

export type DesktopBridgeMode = 'off' | 'cdp' | 'agent'

export interface DesktopCdpRpcBridge {
  startTurn(params: Record<string, unknown>): Promise<unknown>
  interruptTurn(params: { threadId: string; turnId: string }): Promise<void>
}

export interface DesktopAgentRpcBridge {
  rpc<T = unknown>(method: string, params: unknown, deviceId?: string): Promise<T>
}

export interface LocalServerRequestBridge {
  listPendingServerRequests(): unknown[]
  respondToServerRequest(payload: unknown): Promise<void>
}

export type DesktopCdpRpcDispatch =
  | { handled: false }
  | { handled: true; result: unknown }

export type DesktopBridgeHealth = DesktopBridgeStatus & {
  enabled: boolean
  mode: DesktopBridgeMode
}

export function buildDesktopBridgeHealth(
  mode: DesktopBridgeMode,
  status: DesktopBridgeStatus,
  connectedAgentCount = 0,
): DesktopBridgeHealth {
  return {
    enabled: mode !== 'off',
    mode,
    ...status,
    ...(mode === 'agent'
      ? {
          state: connectedAgentCount > 0 ? 'ready' : 'disconnected',
          error: connectedAgentCount > 0 ? null : status.error,
        }
      : {}),
  }
}

export function shouldUseLocalCodexAppServer(mode: DesktopBridgeMode): boolean {
  return mode !== 'agent'
}

export function readDesktopBridgeMode(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): DesktopBridgeMode {
  const value = env.CODEXUI_DESKTOP_DRIVER?.trim().toLowerCase() ?? ''
  if (!value || value === '0' || value === 'false' || value === 'off') return 'off'
  if (value === 'cdp') return 'cdp'
  if (value === 'agent') return 'agent'
  if (['1', 'true', 'yes', 'on', 'desktop-ui', 'sendkeys'].includes(value)) {
    throw new Error('The simulated Codex Desktop UI driver was removed. Set CODEXUI_DESKTOP_DRIVER=cdp.')
  }
  throw new Error(`Unsupported CODEXUI_DESKTOP_DRIVER mode: ${value}.`)
}

export async function dispatchDesktopCdpRpc(
  method: string,
  params: unknown,
  bridge: DesktopCdpRpcBridge,
): Promise<DesktopCdpRpcDispatch> {
  if (method === 'turn/start') {
    const record = asRecord(params)
    if (!record) throw new Error('Desktop Codex turn/start requires an object params payload.')
    return { handled: true, result: await bridge.startTurn(record) }
  }

  if (method === 'turn/interrupt') {
    const record = asRecord(params)
    const threadId = typeof record?.threadId === 'string' ? record.threadId.trim() : ''
    const turnId = typeof record?.turnId === 'string' ? record.turnId.trim() : ''
    if (!threadId || !turnId) {
      throw new Error('Desktop Codex turn/interrupt requires threadId and turnId.')
    }
    await bridge.interruptTurn({ threadId, turnId })
    return { handled: true, result: {} }
  }

  return { handled: false }
}

export async function dispatchDesktopAgentRpc(
  method: string,
  params: unknown,
  bridge: DesktopAgentRpcBridge,
  deviceId?: string,
): Promise<DesktopCdpRpcDispatch> {
  return {
    handled: true,
    result: await bridge.rpc(method, params ?? null, deviceId),
  }
}

export async function dispatchDesktopAgentLocalOperation(
  mode: DesktopBridgeMode,
  operation: string,
  params: unknown,
  bridge: DesktopAgentRpcBridge,
  deviceId?: string,
): Promise<DesktopCdpRpcDispatch> {
  if (mode !== 'agent') return { handled: false }
  return {
    handled: true,
    result: await bridge.rpc(`codex-web/local/${operation}`, params ?? null, deviceId),
  }
}

export async function listDesktopServerRequests(
  mode: DesktopBridgeMode,
  localBridge: LocalServerRequestBridge,
  agentBridge: DesktopAgentRpcBridge,
  deviceId?: string,
  cdpBridge?: DesktopAgentRpcBridge,
): Promise<unknown[]> {
  if (mode === 'off') return localBridge.listPendingServerRequests()
  if (mode === 'cdp' && !cdpBridge) throw new Error('Codex Desktop CDP bridge is unavailable.')
  const result = mode === 'agent'
    ? await agentBridge.rpc<unknown>('codex-web/local/server-requests/pending', null, deviceId)
    : await cdpBridge!.rpc<unknown>('codex-web/local/server-requests/pending', null)
  if (!Array.isArray(result)) {
    throw new Error('Desktop agent returned an invalid pending server-request snapshot.')
  }
  return result
}

export async function respondToDesktopServerRequest(
  mode: DesktopBridgeMode,
  payload: unknown,
  localBridge: LocalServerRequestBridge,
  agentBridge: DesktopAgentRpcBridge,
  deviceId?: string,
  cdpBridge?: DesktopAgentRpcBridge,
): Promise<void> {
  if (mode === 'off') {
    await localBridge.respondToServerRequest(payload)
    return
  }
  if (mode === 'agent') {
    await agentBridge.rpc('codex-web/local/server-requests/respond', payload, deviceId)
    return
  }
  if (!cdpBridge) throw new Error('Codex Desktop CDP bridge is unavailable.')
  await cdpBridge.rpc('codex-web/local/server-requests/respond', payload)
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : null
}
