import { spawn } from 'node:child_process'
import type {
  CodexDesktopProcess,
  CodexRendererTarget,
  DevToolsTargetDescription,
} from './types'

type DiscoveryDependencies = {
  readProcesses?: () => Promise<CodexDesktopProcess[]>
  readTargets?: (port: number) => Promise<DevToolsTargetDescription[]>
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>
}

export function parseRemoteDebuggingPort(commandLine: string): number | null {
  const match = commandLine.match(/(?:^|\s)--remote-debugging-port(?:=|\s+)(\d+)(?:\s|$)/u)
  if (!match) return null
  const port = Number.parseInt(match[1], 10)
  return Number.isInteger(port) && port >= 1 && port <= 65_535 ? port : null
}

export function selectCodexRendererTarget(
  port: number,
  targets: DevToolsTargetDescription[],
): Pick<CodexRendererTarget, 'port' | 'webSocketDebuggerUrl'> {
  const target = targets.find((candidate) => candidate.type === 'page' && candidate.url === 'app://-/index.html')
  if (!target?.webSocketDebuggerUrl) {
    throw new Error('Codex Desktop renderer target app://-/index.html was not found.')
  }

  let endpoint: URL
  try {
    endpoint = new URL(target.webSocketDebuggerUrl)
  } catch {
    throw new Error('Codex Desktop renderer returned an invalid WebSocket endpoint.')
  }
  if (endpoint.protocol !== 'ws:' || endpoint.hostname !== '127.0.0.1') {
    throw new Error('Codex Desktop CDP WebSocket must use an IPv4 loopback endpoint.')
  }
  const endpointPort = Number.parseInt(endpoint.port, 10)
  if (endpointPort !== port) {
    throw new Error('Codex Desktop CDP WebSocket port does not match the discovered process.')
  }

  return { port, webSocketDebuggerUrl: target.webSocketDebuggerUrl }
}

export async function discoverCodexDesktopRenderer(
  dependencies: DiscoveryDependencies = {},
): Promise<CodexRendererTarget> {
  const readProcesses = dependencies.readProcesses ?? readWindowsCodexProcesses
  const readTargets = dependencies.readTargets ?? readDevToolsTargets
  const overridePort = parsePortOverride(dependencies.env ?? process.env)
  const processes = (await readProcesses()).filter(isCodexDesktopProcess)
  const candidates = overridePort === null
    ? processes.flatMap((process) => {
        const port = parseRemoteDebuggingPort(process.commandLine)
        return port === null ? [] : [{ process, port }]
      })
    : processes.map((process) => ({ process, port: overridePort }))

  let lastError: Error | null = null
  for (const { process, port } of candidates) {
    try {
      const selected = selectCodexRendererTarget(port, await readTargets(port))
      return {
        ...selected,
        processId: process.processId,
        appVersion: readCodexAppVersion(process.executablePath),
      }
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))
    }
  }

  const detail = lastError ? ` ${lastError.message}` : ''
  throw new Error(`Codex Desktop renderer is unavailable.${detail}`)
}

async function readWindowsCodexProcesses(): Promise<CodexDesktopProcess[]> {
  if (process.platform !== 'win32') {
    throw new Error('Codex Desktop CDP discovery is currently supported only on Windows.')
  }
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "@(Get-CimInstance Win32_Process | Where-Object { $_.Name -in @('ChatGPT.exe', 'Codex.exe') } | ForEach-Object {",
    "  [pscustomobject]@{ processId = [int]$_.ProcessId; executablePath = [string]$_.ExecutablePath; commandLine = [string]$_.CommandLine }",
    '}) | ConvertTo-Json -Compress',
  ].join('; ')
  const output = await runHiddenPowerShell(script)
  if (!output.trim()) return []
  const parsed = JSON.parse(output) as unknown
  const records = Array.isArray(parsed) ? parsed : [parsed]
  return records.flatMap((value) => {
    const record = asRecord(value)
    const processId = typeof record?.processId === 'number' ? record.processId : Number(record?.processId)
    const executablePath = typeof record?.executablePath === 'string' ? record.executablePath : ''
    const commandLine = typeof record?.commandLine === 'string' ? record.commandLine : ''
    return Number.isInteger(processId) && processId > 0
      ? [{ processId, executablePath, commandLine }]
      : []
  })
}

async function readDevToolsTargets(port: number): Promise<DevToolsTargetDescription[]> {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
    signal: AbortSignal.timeout(3_000),
  })
  if (!response.ok) {
    throw new Error(`Codex Desktop CDP target discovery failed with HTTP ${response.status}.`)
  }
  const value = await response.json() as unknown
  if (!Array.isArray(value)) throw new Error('Codex Desktop CDP target response is not an array.')
  return value as DevToolsTargetDescription[]
}

function runHiddenPowerShell(script: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
      if (stdout.length > 1_000_000) child.kill()
    })
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk
    })
    child.once('error', reject)
    child.once('exit', (code) => {
      if (code === 0) resolve(stdout)
      else reject(new Error(stderr.trim() || `PowerShell process discovery exited with code ${code ?? 'unknown'}.`))
    })
  })
}

function isCodexDesktopProcess(processInfo: CodexDesktopProcess): boolean {
  const path = processInfo.executablePath.replace(/\//gu, '\\')
  return /\\OpenAI\.Codex_[^\\]+\\app\\ChatGPT\.exe$/iu.test(path)
    || /\\Codex(?:\.app)?\\.*\\Codex\.exe$/iu.test(path)
}

function readCodexAppVersion(executablePath: string): string | null {
  return executablePath.match(/OpenAI\.Codex_([0-9.]+)_/iu)?.[1] ?? null
}

function parsePortOverride(env: NodeJS.ProcessEnv | Record<string, string | undefined>): number | null {
  const raw = env.CODEX_DESKTOP_CDP_PORT?.trim()
  if (!raw) return null
  const port = Number.parseInt(raw, 10)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('CODEX_DESKTOP_CDP_PORT must be an integer between 1 and 65535.')
  }
  return port
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : null
}
