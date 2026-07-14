export type CdpEvent = {
  method: string
  params?: unknown
}

export type CdpErrorPayload = {
  code: number
  message: string
  data?: unknown
}

export type CodexRendererTarget = {
  port: number
  processId: number
  appVersion: string | null
  webSocketDebuggerUrl: string
}

export type CodexDesktopProcess = {
  processId: number
  executablePath: string
  commandLine: string
}

export type DevToolsTargetDescription = {
  type?: string
  title?: string
  url?: string
  webSocketDebuggerUrl?: string
}
