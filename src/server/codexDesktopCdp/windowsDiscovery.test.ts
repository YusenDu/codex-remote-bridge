import { describe, expect, it, vi } from 'vitest'
import {
  discoverCodexDesktopRenderer,
  parseRemoteDebuggingPort,
  selectCodexRendererTarget,
} from './windowsDiscovery'

describe('Windows Codex Desktop CDP discovery', () => {
  it('parses only valid remote debugging ports', () => {
    expect(parseRemoteDebuggingPort('ChatGPT.exe --remote-debugging-port=60068')).toBe(60068)
    expect(parseRemoteDebuggingPort('Codex.exe --remote-debugging-port 9222')).toBe(9222)
    expect(parseRemoteDebuggingPort('Codex.exe --remote-debugging-port=0')).toBeNull()
    expect(parseRemoteDebuggingPort('Codex.exe --remote-debugging-port=70000')).toBeNull()
    expect(parseRemoteDebuggingPort('Codex.exe')).toBeNull()
  })

  it('selects only the exact loopback Codex renderer target', () => {
    const selected = selectCodexRendererTarget(60068, [
      {
        type: 'page',
        title: 'Codex copy',
        url: 'http://127.0.0.1:5900/',
        webSocketDebuggerUrl: 'ws://127.0.0.1:60068/devtools/page/web',
      },
      {
        type: 'page',
        title: 'Codex',
        url: 'app://-/index.html',
        webSocketDebuggerUrl: 'ws://127.0.0.1:60068/devtools/page/main',
      },
    ])

    expect(selected).toEqual({
      port: 60068,
      webSocketDebuggerUrl: 'ws://127.0.0.1:60068/devtools/page/main',
    })
    expect(() => selectCodexRendererTarget(60068, [{
      type: 'page',
      title: 'Codex',
      url: 'app://-/index.html',
      webSocketDebuggerUrl: 'ws://192.168.1.20:60068/devtools/page/main',
    }])).toThrow('loopback')
  })

  it('discovers the installed Codex process and validates its renderer', async () => {
    const readProcesses = vi.fn().mockResolvedValue([
      {
        processId: 40972,
        executablePath: 'C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.707.3748.0_x64__test\\app\\ChatGPT.exe',
        commandLine: 'ChatGPT.exe --remote-debugging-port=60068',
      },
      {
        processId: 12,
        executablePath: 'C:\\Other\\ChatGPT.exe',
        commandLine: 'ChatGPT.exe --remote-debugging-port=4444',
      },
    ])
    const readTargets = vi.fn().mockResolvedValue([{
      type: 'page',
      title: 'Codex',
      url: 'app://-/index.html',
      webSocketDebuggerUrl: 'ws://127.0.0.1:60068/devtools/page/main',
    }])

    await expect(discoverCodexDesktopRenderer({ readProcesses, readTargets })).resolves.toEqual({
      port: 60068,
      processId: 40972,
      appVersion: '26.707.3748.0',
      webSocketDebuggerUrl: 'ws://127.0.0.1:60068/devtools/page/main',
    })
    expect(readTargets).toHaveBeenCalledWith(60068)
  })

  it('fails closed when no validated renderer is available', async () => {
    await expect(discoverCodexDesktopRenderer({
      readProcesses: async () => [{
        processId: 40972,
        executablePath: 'C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.707.3748.0_x64__test\\app\\ChatGPT.exe',
        commandLine: 'ChatGPT.exe --remote-debugging-port=60068',
      }],
      readTargets: async () => [{
        type: 'page',
        title: 'Not Codex',
        url: 'https://example.com/',
        webSocketDebuggerUrl: 'ws://127.0.0.1:60068/devtools/page/other',
      }],
    })).rejects.toThrow('Codex Desktop renderer')
  })
})
