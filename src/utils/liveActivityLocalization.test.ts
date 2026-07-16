import { describe, expect, it } from 'vitest'

import {
  localizeLiveActivityLabel,
  localizeLiveReasoningText,
} from './liveActivityLocalization'

describe('live activity localization', () => {
  it('localizes the stable activity labels shown by Codex Desktop', () => {
    expect(localizeLiveActivityLabel('Thinking')).toBe('正在思考')
    expect(localizeLiveActivityLabel('Planning')).toBe('正在规划')
    expect(localizeLiveActivityLabel('Running command')).toBe('正在运行命令')
    expect(localizeLiveActivityLabel('Writing response')).toBe('正在整理回复')
  })

  it('keeps unknown labels unchanged', () => {
    expect(localizeLiveActivityLabel('Waiting for desktop')).toBe('Waiting for desktop')
  })

  it('localizes common reasoning actions and phrases line by line', () => {
    expect(
      localizeLiveReasoningText(
        [
          'Planning event journal and sequence ack',
          'Inspecting file upload mechanism',
          'Inspecting LiveAgent image proxy security',
        ].join('\n'),
      ),
    ).toBe(
      [
        '规划事件日志与序列确认',
        '检查文件上传机制',
        '检查 LiveAgent 图片代理安全性',
      ].join('\n'),
    )
  })

  it('preserves existing Chinese, code spans, paths, URLs, and unknown wording', () => {
    expect(localizeLiveReasoningText('正在检查文件上传机制')).toBe('正在检查文件上传机制')
    expect(localizeLiveReasoningText('Inspecting `thread/read` response')).toBe(
      '检查 `thread/read` 响应',
    )
    expect(localizeLiveReasoningText('Inspecting K:\\codex-mcp')).toBe(
      '检查 K:\\codex-mcp',
    )
    expect(localizeLiveReasoningText('Inspecting https://example.com/api')).toBe(
      '检查 https://example.com/api',
    )
    expect(localizeLiveReasoningText('A phrase the UI does not know')).toBe(
      'A phrase the UI does not know',
    )
  })

  it('separates adjacent bold streaming segments before rendering markdown', () => {
    expect(
      localizeLiveReasoningText(
        '**Deciding to use exec_command tool****Inspecting ThreadComposer template and upload routing**',
      ),
    ).toBe(
      '**决定使用 exec_command 工具**\n**检查 ThreadComposer 模板与上传路由**',
    )
  })
})
