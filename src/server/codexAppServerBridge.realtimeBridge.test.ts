import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CODEX_WEB_BRIDGE_METADATA_KEY,
  BridgeNotificationBus,
  ThreadSessionFileWatcher,
  emitBridgeUserMessageSubmitted,
  forwardDesktopBridgeEvent,
  mergeSessionCommandsIntoThreadResult,
  normalizeDesktopAgentDeviceId,
  readDesktopAgentDeviceIdFromUrl,
  readBridgeUserMessageFromTurnStart,
  readDesktopAgentDeviceId,
  readThreadSessionRuntimeState,
  readThreadSessionWatchTarget,
  shouldDeliverDesktopAgentNotification,
  stripCodexWebBridgeMetadataFromParams,
} from './codexAppServerBridge'

describe('realtime bridge turn metadata', () => {
  const temporaryDirectories: string[] = []

  afterEach(async () => {
    await Promise.all(temporaryDirectories.map((dir) => rm(dir, { recursive: true, force: true })))
    temporaryDirectories.length = 0
  })

  it('preserves the source device on forwarded Desktop agent events', () => {
    const notifications: unknown[] = []
    const bus = new BridgeNotificationBus()
    bus.subscribe((notification) => notifications.push(notification))

    forwardDesktopBridgeEvent(bus, {
      protocol: 1,
      kind: 'notification',
      sequence: 7,
      payload: {
        method: 'turn/started',
        params: { threadId: 'thread-a' },
      },
    }, 'desktop-a')

    expect(notifications).toEqual([expect.objectContaining({
      method: 'turn/started',
      params: { threadId: 'thread-a' },
      deviceId: 'desktop-a',
    })])
  })

  it('prefers a validated top-level machine code over compatibility fallbacks', () => {
    const params = {
      [CODEX_WEB_BRIDGE_METADATA_KEY]: { deviceId: 'desktop-metadata' },
    }

    expect(normalizeDesktopAgentDeviceId(' desktop-a:b ')).toBe('desktop-a:b')
    expect(normalizeDesktopAgentDeviceId('../desktop-a')).toBeUndefined()
    expect(readDesktopAgentDeviceId(params, 'desktop-top', {
      CODEXUI_AGENT_DEVICE_ID: 'desktop-env',
    })).toBe('desktop-top')
    expect(readDesktopAgentDeviceId(params, undefined, {})).toBe('desktop-metadata')
  })

  it('reads a validated machine code from local API query parameters', () => {
    expect(readDesktopAgentDeviceIdFromUrl(new URL(
      'https://codex.example.com/codex-api/git/branches?deviceId=desktop-a',
    ))).toBe('desktop-a')
    expect(readDesktopAgentDeviceIdFromUrl(new URL(
      'https://codex.example.com/codex-api/git/branches',
    ))).toBeUndefined()
    expect(() => readDesktopAgentDeviceIdFromUrl(new URL(
      'https://codex.example.com/codex-api/git/branches?deviceId=../desktop-a',
    ))).toThrow('deviceId is invalid')
  })

  it('scopes optimistic web user messages to the requested machine', () => {
    const notifications: unknown[] = []
    const bus = new BridgeNotificationBus()
    bus.subscribe((notification) => notifications.push(notification))

    emitBridgeUserMessageSubmitted(bus, {
      threadId: 'thread-1',
      input: [{ type: 'text', text: 'route this' }],
      [CODEX_WEB_BRIDGE_METADATA_KEY]: {
        clientId: 'browser-1',
        submissionId: 'submission-1',
        threadId: 'thread-1',
        text: 'route this',
        imageUrls: [],
        skills: [],
        fileAttachments: [],
        createdAtIso: '2026-07-13T00:00:00.000Z',
      },
    }, { turn: { id: 'turn-1' } }, 'desktop-a')

    expect(notifications).toEqual([expect.objectContaining({
      method: 'bridge/user-message-submitted',
      deviceId: 'desktop-a',
    })])
  })

  it('delivers device events only to the selected or sole connected device', () => {
    expect(shouldDeliverDesktopAgentNotification(undefined, undefined, undefined, ['desktop-a'])).toBe(true)
    expect(shouldDeliverDesktopAgentNotification('desktop-a', 'desktop-a', undefined, ['desktop-a', 'desktop-b'])).toBe(true)
    expect(shouldDeliverDesktopAgentNotification('desktop-b', 'desktop-a', undefined, ['desktop-a', 'desktop-b'])).toBe(false)
    expect(shouldDeliverDesktopAgentNotification('desktop-a', undefined, undefined, ['desktop-a'])).toBe(true)
    expect(shouldDeliverDesktopAgentNotification('desktop-a', undefined, undefined, ['desktop-a', 'desktop-b'])).toBe(false)
    expect(shouldDeliverDesktopAgentNotification('desktop-a', undefined, 'desktop-b', ['desktop-a', 'desktop-b'])).toBe(false)
  })

  it('strips web bridge metadata before forwarding params to Codex', () => {
    const params = {
      threadId: 'thread-1',
      input: [{ type: 'text', text: 'hello' }],
      [CODEX_WEB_BRIDGE_METADATA_KEY]: {
        clientId: 'browser-1',
        submissionId: 'submission-1',
      },
    }

    expect(stripCodexWebBridgeMetadataFromParams(params)).toEqual({
      threadId: 'thread-1',
      input: [{ type: 'text', text: 'hello' }],
    })
    expect(params).toHaveProperty(CODEX_WEB_BRIDGE_METADATA_KEY)
  })

  it('normalizes submitted user messages from turn/start metadata', () => {
    const submitted = readBridgeUserMessageFromTurnStart({
      threadId: 'thread-1',
      input: [{ type: 'text', text: 'fallback text' }],
      [CODEX_WEB_BRIDGE_METADATA_KEY]: {
        clientId: 'browser-1',
        submissionId: 'submission-1',
        threadId: 'thread-1',
        text: 'sync this',
        imageUrls: [' /codex-local-image?path=a.png '],
        skills: [{ name: 'browser', path: '/skills/browser/SKILL.md' }],
        fileAttachments: [{ label: 'README.md', path: 'README.md', fsPath: '/tmp/README.md' }],
        createdAtIso: '2026-07-09T00:00:00.000Z',
      },
    }, {
      turn: { id: 'turn-1' },
    })

    expect(submitted).toEqual({
      threadId: 'thread-1',
      turnId: 'turn-1',
      submissionId: 'submission-1',
      originClientId: 'browser-1',
      text: 'sync this',
      imageUrls: ['/codex-local-image?path=a.png'],
      skills: [{ name: 'browser', path: '/skills/browser/SKILL.md' }],
      fileAttachments: [{ label: 'README.md', path: 'README.md', fsPath: '/tmp/README.md' }],
      createdAtIso: '2026-07-09T00:00:00.000Z',
    })
  })

  it('reads a watch target from thread responses that include a session path', () => {
    expect(readThreadSessionWatchTarget({
      thread: {
        id: 'thread-1',
        path: 'C:\\Users\\tester\\.codex\\sessions\\rollout.jsonl',
      },
    })).toEqual({
      threadId: 'thread-1',
      path: 'C:\\Users\\tester\\.codex\\sessions\\rollout.jsonl',
    })
  })

  it('emits a bridge notification when a watched desktop session file changes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codex-session-watch-'))
    temporaryDirectories.push(dir)
    const sessionPath = join(dir, 'rollout.jsonl')
    await writeFile(sessionPath, '{}\n', 'utf8')

    const events: Array<{ threadId: string; path: string; stats: { mtimeMs: number; size: number } }> = []
    const watcher = new ThreadSessionFileWatcher((threadId, path, stats) => {
      events.push({ threadId, path, stats })
    }, {
      intervalMs: 30,
      debounceMs: 5,
    })

    try {
      watcher.watchThreadSession('thread-1', sessionPath)
      await writeFile(sessionPath, '{}\n{}\n', 'utf8')
      await new Promise<void>((resolve) => setTimeout(resolve, 150))
    } finally {
      watcher.dispose()
    }

    expect(events).toHaveLength(1)
    expect(events[0].threadId).toBe('thread-1')
    expect(events[0].path).toBe(sessionPath)
    expect(events[0].stats.size).toBeGreaterThan(0)
  })

  it('merges session-recovered commands into thread responses used by chat history', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codex-session-commands-'))
    temporaryDirectories.push(dir)
    const sessionPath = join(dir, 'rollout.jsonl')
    await writeFile(sessionPath, [
      JSON.stringify({ type: 'turn_context', payload: { turn_id: 'turn-1' } }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'function_call',
          name: 'shell_command',
          call_id: 'call-1',
          arguments: JSON.stringify({ command: 'Get-Location', workdir: 'K:\\codex-web\\codex-mobile' }),
        },
      }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'function_call_output',
          call_id: 'call-1',
          output: 'Exit code: 0\nWall time: 0.1 seconds\nOutput:\nK:\\codex-web\\codex-mobile\n',
        },
      }),
      '',
    ].join('\n'), 'utf8')

    const result = await mergeSessionCommandsIntoThreadResult('thread/read', {
      thread: {
        id: 'thread-1',
        path: sessionPath,
        turns: [
          {
            id: 'turn-1',
            status: 'completed',
            items: [
              { id: 'user-1', type: 'userMessage', text: 'where am I' },
              { id: 'agent-1', type: 'agentMessage', text: 'Here is the command output.' },
            ],
          },
        ],
      },
    })

    const turn = (result as { thread: { turns: Array<{ items: Array<Record<string, unknown>> }> } }).thread.turns[0]
    expect(turn.items.map((item) => item.type)).toEqual(['userMessage', 'commandExecution', 'agentMessage'])
    expect(turn.items[1]).toMatchObject({
      type: 'commandExecution',
      command: 'Get-Location',
      cwd: 'K:\\codex-web\\codex-mobile',
      status: 'completed',
      aggregatedOutput: 'K:\\codex-web\\codex-mobile',
      exitCode: 0,
    })
  })

  it('detects an active desktop turn until its task_complete event arrives', () => {
    const started = JSON.stringify({
      type: 'event_msg',
      payload: { type: 'task_started', turn_id: 'turn-desktop' },
    })
    const completed = JSON.stringify({
      type: 'event_msg',
      payload: { type: 'task_complete', turn_id: 'turn-desktop' },
    })

    expect(readThreadSessionRuntimeState(`${started}\n`)).toEqual({
      isInProgress: true,
      activeTurnId: 'turn-desktop',
    })
    expect(readThreadSessionRuntimeState(`${started}\n${completed}\n`)).toEqual({
      isInProgress: false,
      activeTurnId: '',
    })
  })

  it('clears an active desktop turn when Codex reports turn_aborted', () => {
    const started = JSON.stringify({
      type: 'event_msg',
      payload: { type: 'task_started', turn_id: 'turn-desktop' },
    })
    const aborted = JSON.stringify({
      type: 'event_msg',
      payload: { type: 'turn_aborted', turn_id: 'turn-desktop' },
    })

    expect(readThreadSessionRuntimeState(`${started}\n${aborted}\n`)).toEqual({
      isInProgress: false,
      activeTurnId: '',
    })
  })

  it('overrides a stale app-server turn status while the desktop task is active', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codex-session-runtime-'))
    temporaryDirectories.push(dir)
    const sessionPath = join(dir, 'rollout.jsonl')
    await writeFile(sessionPath, `${JSON.stringify({
      type: 'event_msg',
      payload: { type: 'task_started', turn_id: 'turn-desktop' },
    })}\n`, 'utf8')

    const result = await mergeSessionCommandsIntoThreadResult('thread/read', {
      thread: {
        id: 'thread-1',
        path: sessionPath,
        status: { type: 'idle' },
        turns: [{ id: 'turn-desktop', status: 'interrupted', items: [] }],
      },
    }) as {
      thread: {
        status: { type: string }
        turns: Array<{ id: string; status: string }>
      }
    }

    expect(result.thread.status.type).toBe('inProgress')
    expect(result.thread.turns[0].status).toBe('inProgress')
  })

  it('recovers shell commands wrapped by the current custom exec tool format', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codex-session-custom-exec-'))
    temporaryDirectories.push(dir)
    const sessionPath = join(dir, 'rollout.jsonl')
    await writeFile(sessionPath, [
      JSON.stringify({ type: 'turn_context', payload: { turn_id: 'turn-1' } }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'custom_tool_call',
          name: 'exec',
          call_id: 'call-custom-1',
          input: "const r = await tools.shell_command({command:'Get-Date',workdir:'K:\\\\work',timeout_ms:10000});",
        },
      }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'custom_tool_call_output',
          call_id: 'call-custom-1',
          output: [
            { type: 'input_text', text: 'Script completed\nWall time: 0.2 seconds\nOutput:\nThursday\n' },
          ],
        },
      }),
      '',
    ].join('\n'), 'utf8')

    const result = await mergeSessionCommandsIntoThreadResult('thread/read', {
      thread: {
        id: 'thread-1',
        path: sessionPath,
        turns: [{
          id: 'turn-1',
          status: 'completed',
          items: [
            { id: 'user-1', type: 'userMessage', text: 'what day is it' },
            { id: 'agent-1', type: 'agentMessage', text: 'Thursday' },
          ],
        }],
      },
    }) as { thread: { turns: Array<{ items: Array<Record<string, unknown>> }> } }

    const command = result.thread.turns[0].items.find((item) => item.type === 'commandExecution')
    expect(command).toMatchObject({
      command: 'Get-Date',
      cwd: 'K:\\work',
      status: 'completed',
      aggregatedOutput: 'Thursday',
    })
  })

  it('recovers mixed turn tools without duplicating canonical items', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codex-session-mixed-tools-'))
    temporaryDirectories.push(dir)
    const sessionPath = join(dir, 'rollout.jsonl')
    const longArgument = 'query-'.repeat(12_000)
    const longResult = 'result-'.repeat(12_000)
    await writeFile(sessionPath, [
      JSON.stringify({ type: 'turn_context', payload: { turn_id: 'turn-mixed' } }),
      JSON.stringify({
        type: 'response_item',
        payload: { type: 'message', role: 'assistant', content: [] },
      }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'function_call',
          name: 'exec_command',
          call_id: 'legacy-1',
          arguments: JSON.stringify({ cmd: 'Get-Location', cwd: 'K:\\workspace' }),
        },
      }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'function_call_output',
          call_id: 'legacy-1',
          output: 'Process exited with code 0\nWall time: 0.1 seconds\nOutput:\nK:\\workspace\n',
        },
      }),
      JSON.stringify({
        type: 'response_item',
        payload: { type: 'message', role: 'assistant', content: [] },
      }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'custom_tool_call',
          name: 'exec',
          call_id: 'custom-1',
          input: 'const r = await tools.exec_command({cmd:"Get-Date",workdir:"K:\\\\workspace"});',
        },
      }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'custom_tool_call_output',
          call_id: 'custom-1',
          output: [{ type: 'input_text', text: 'Script completed\nWall time: 0.2 seconds\nOutput:\nFriday\n' }],
        },
      }),
      JSON.stringify({
        type: 'response_item',
        payload: { type: 'message', role: 'assistant', content: [] },
      }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'function_call',
          name: 'mcp__github__search_issues',
          call_id: 'plugin-1',
          arguments: JSON.stringify({ query: longArgument }),
        },
      }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'function_call_output',
          call_id: 'plugin-1',
          output: {
            body: `Wall time: 0.3 seconds\nOutput:\n${JSON.stringify([{ type: 'text', text: longResult }])}\n`,
            success: true,
          },
        },
      }),
      JSON.stringify({
        type: 'response_item',
        payload: { type: 'message', role: 'assistant', content: [] },
      }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'function_call',
          namespace: 'mcp__node_repl',
          name: 'js',
          call_id: 'browser-1',
          arguments: JSON.stringify({ code: longArgument }),
        },
      }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'function_call_output',
          call_id: 'browser-1',
          output: `Wall time: 0.4 seconds\nOutput:\n${JSON.stringify([{ type: 'text', text: 'canonical browser result' }])}\n`,
        },
      }),
      '',
    ].join('\n'), 'utf8')

    const canonicalBrowserResult = {
      content: [{ type: 'text', text: 'canonical browser result' }],
      structuredContent: null,
    }
    const result = await mergeSessionCommandsIntoThreadResult('thread/read', {
      thread: {
        id: 'thread-1',
        path: sessionPath,
        turns: [{
          id: 'turn-mixed',
          status: 'completed',
          items: [
            { id: 'user-1', type: 'userMessage', text: 'recover the tools' },
            { id: 'agent-1', type: 'agentMessage', text: 'First response.' },
            {
              id: 'canonical-file-change',
              type: 'fileChange',
              status: 'completed',
              changes: [{ path: 'src/existing.ts', kind: { type: 'update' } }],
            },
            { id: 'agent-2', type: 'agentMessage', text: 'Second response.' },
            { id: 'agent-3', type: 'agentMessage', text: 'Third response.' },
            { id: 'agent-4', type: 'agentMessage', text: 'Fourth response.' },
            {
              id: 'canonical-browser-call',
              type: 'mcpToolCall',
              server: 'node_repl',
              tool: 'js',
              status: 'completed',
              arguments: { code: longArgument },
              result: canonicalBrowserResult,
              error: null,
              durationMs: 7,
            },
          ],
        }],
      },
    }) as { thread: { turns: Array<{ items: Array<Record<string, unknown>> }> } }

    const items = result.thread.turns[0].items
    expect(items.map((item) => [item.type, item.id])).toEqual([
      ['userMessage', 'user-1'],
      ['agentMessage', 'agent-1'],
      ['commandExecution', 'session-cmd-legacy-1'],
      ['fileChange', 'canonical-file-change'],
      ['agentMessage', 'agent-2'],
      ['commandExecution', 'session-cmd-custom-1'],
      ['agentMessage', 'agent-3'],
      ['mcpToolCall', 'session-mcp-plugin-1'],
      ['agentMessage', 'agent-4'],
      ['mcpToolCall', 'canonical-browser-call'],
    ])

    const mcpItems = items.filter((item) => item.type === 'mcpToolCall')
    expect(mcpItems).toHaveLength(2)
    expect(mcpItems[1]).toMatchObject({
      id: 'canonical-browser-call',
      result: canonicalBrowserResult,
      durationMs: 7,
    })

    const pluginCall = mcpItems[0] as {
      server: string
      tool: string
      status: string
      arguments: { query: string }
      result: { content: Array<{ type: string; text: string }>; structuredContent: unknown }
      error: unknown
      durationMs: number
    }
    expect(pluginCall).toMatchObject({
      server: 'github',
      tool: 'search_issues',
      status: 'completed',
      error: null,
      durationMs: 300,
    })
    expect(pluginCall.arguments.query.length).toBeLessThan(longArgument.length)
    expect(pluginCall.result.content[0].text.length).toBeLessThan(longResult.length)
  })

  it('keeps distinct repeated recovered calls', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codex-session-repeated-tools-'))
    temporaryDirectories.push(dir)
    const sessionPath = join(dir, 'rollout.jsonl')
    await writeFile(sessionPath, [
      JSON.stringify({ type: 'turn_context', payload: { turn_id: 'turn-repeated' } }),
      ...['repeat-1', 'repeat-2'].flatMap((callId) => [
        JSON.stringify({
          type: 'response_item',
          payload: {
            type: 'function_call',
            name: 'exec_command',
            call_id: callId,
            arguments: JSON.stringify({ cmd: 'Get-Date', cwd: 'K:\\workspace' }),
          },
        }),
        JSON.stringify({
          type: 'response_item',
          payload: {
            type: 'function_call_output',
            call_id: callId,
            output: 'Process exited with code 0\nOutput:\nFriday\n',
          },
        }),
      ]),
      '',
    ].join('\n'), 'utf8')

    const result = await mergeSessionCommandsIntoThreadResult('thread/read', {
      thread: {
        id: 'thread-1',
        path: sessionPath,
        turns: [{
          id: 'turn-repeated',
          status: 'completed',
          items: [{ id: 'user-1', type: 'userMessage', text: 'run it twice' }],
        }],
      },
    }) as { thread: { turns: Array<{ items: Array<Record<string, unknown>> }> } }

    expect(result.thread.turns[0].items.map((item) => item.id)).toEqual([
      'user-1',
      'session-cmd-repeat-1',
      'session-cmd-repeat-2',
    ])
  })

  it('marks recovered tool failures as failed', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codex-session-failed-tools-'))
    temporaryDirectories.push(dir)
    const sessionPath = join(dir, 'rollout.jsonl')
    await writeFile(sessionPath, [
      JSON.stringify({ type: 'turn_context', payload: { turn_id: 'turn-failed' } }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'custom_tool_call',
          name: 'exec',
          call_id: 'failed-command',
          input: 'const r = await tools.exec_command({cmd:"Get-Date",workdir:"K:\\\\workspace"});',
        },
      }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'custom_tool_call_output',
          call_id: 'failed-command',
          output: [{ type: 'input_text', text: 'Script failed\nOutput:\ncommand failed\n' }],
        },
      }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'function_call',
          namespace: 'mcp__github',
          name: 'get_issue',
          call_id: 'failed-plugin',
          arguments: JSON.stringify({ issue: 42 }),
        },
      }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'function_call_output',
          call_id: 'failed-plugin',
          output: { body: 'permission denied', success: false },
        },
      }),
      '',
    ].join('\n'), 'utf8')

    const result = await mergeSessionCommandsIntoThreadResult('thread/read', {
      thread: {
        id: 'thread-1',
        path: sessionPath,
        turns: [{ id: 'turn-failed', status: 'completed', items: [] }],
      },
    }) as { thread: { turns: Array<{ items: Array<Record<string, unknown>> }> } }

    expect(result.thread.turns[0].items).toEqual([
      expect.objectContaining({
        id: 'session-cmd-failed-command',
        type: 'commandExecution',
        status: 'failed',
        aggregatedOutput: 'command failed',
      }),
      expect.objectContaining({
        id: 'session-mcp-failed-plugin',
        type: 'mcpToolCall',
        status: 'failed',
        result: null,
        error: { message: 'permission denied' },
      }),
    ])
  })

  it('does not treat successful output text as a script failure marker', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codex-session-success-marker-'))
    temporaryDirectories.push(dir)
    const sessionPath = join(dir, 'rollout.jsonl')
    await writeFile(sessionPath, [
      JSON.stringify({ type: 'turn_context', payload: { turn_id: 'turn-success-marker' } }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'custom_tool_call',
          name: 'exec',
          call_id: 'successful-command',
          input: 'const r = await tools.exec_command({cmd:"Write-Output \'Script failed\'",workdir:"K:\\\\workspace"});',
        },
      }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'custom_tool_call_output',
          call_id: 'successful-command',
          output: [{ type: 'input_text', text: 'Script completed\nOutput:\nScript failed\n' }],
        },
      }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'function_call',
          namespace: 'mcp__github',
          name: 'echo',
          call_id: 'successful-plugin',
          arguments: JSON.stringify({ text: 'Script failed' }),
        },
      }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'function_call_output',
          call_id: 'successful-plugin',
          output: { body: 'Script failed', success: true },
        },
      }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'function_call',
          name: 'exec_command',
          call_id: 'successful-legacy-command',
          arguments: JSON.stringify({ cmd: "Write-Output 'Script failed'", cwd: 'K:\\workspace' }),
        },
      }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'function_call_output',
          call_id: 'successful-legacy-command',
          output: { body: 'Script failed', success: true },
        },
      }),
      '',
    ].join('\n'), 'utf8')

    const result = await mergeSessionCommandsIntoThreadResult('thread/read', {
      thread: {
        id: 'thread-1',
        path: sessionPath,
        turns: [{ id: 'turn-success-marker', status: 'completed', items: [] }],
      },
    }) as { thread: { turns: Array<{ items: Array<Record<string, unknown>> }> } }

    expect(result.thread.turns[0].items).toEqual([
      expect.objectContaining({
        id: 'session-cmd-successful-command',
        status: 'completed',
        aggregatedOutput: 'Script failed',
      }),
      expect.objectContaining({
        id: 'session-mcp-successful-plugin',
        status: 'completed',
        error: null,
        result: {
          content: [{ type: 'text', text: 'Script failed' }],
          structuredContent: null,
        },
      }),
      expect.objectContaining({
        id: 'session-cmd-successful-legacy-command',
        status: 'completed',
        aggregatedOutput: 'Script failed',
      }),
    ])
  })
})
