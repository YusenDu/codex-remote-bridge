const ACTIVITY_LABELS: Readonly<Record<string, string>> = {
  Thinking: '正在思考',
  Planning: '正在规划',
  'Running command': '正在运行命令',
  'Writing response': '正在整理回复',
}

const ACTION_REPLACEMENTS: ReadonlyArray<readonly [RegExp, string]> = [
  [/^Deciding to use\b/i, '决定使用'],
  [/^Implementing\b/i, '实现'],
  [/^Inspecting\b/i, '检查'],
  [/^Planning\b/i, '规划'],
  [/^Preparing\b/i, '准备'],
  [/^Reviewing\b/i, '审查'],
  [/^Verifying\b/i, '验证'],
  [/^Checking\b/i, '检查'],
  [/^Reading\b/i, '读取'],
  [/^Running\b/i, '运行'],
  [/^Testing\b/i, '测试'],
  [/^Updating\b/i, '更新'],
  [/^Writing\b/i, '编写'],
  [/^Fixing\b/i, '修复'],
  [/^Waiting\b/i, '等待'],
]

const PHRASE_REPLACEMENTS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bevent journal\b/gi, '事件日志'],
  [/\bsequence ack\b/gi, '序列确认'],
  [/\bfile upload mechanism\b/gi, '文件上传机制'],
  [/\bimage proxy security\b/gi, '图片代理安全性'],
  [/\bupload routing\b/gi, '上传路由'],
  [/\s+and\s+/gi, '与'],
  [/\bresponse\b/gi, '响应'],
  [/\btemplate\b/gi, '模板'],
  [/\btool\b/gi, '工具'],
]

const CJK_PATTERN = /[\u3400-\u9fff]/u
const CODE_SPAN_PATTERN = /(`+[^`]*`+)/gu

export function localizeLiveActivityLabel(label: string): string {
  return ACTIVITY_LABELS[label.trim()] ?? label
}

function localizeReasoningLine(line: string): string {
  if (line.length === 0 || CJK_PATTERN.test(line)) return line

  const boldWrapped = line.startsWith('**') && line.endsWith('**') && line.length > 4
  const prefix = boldWrapped ? '**' : ''
  const suffix = boldWrapped ? '**' : ''
  const content = boldWrapped ? line.slice(2, -2) : line
  let actionMatched = false

  const segments = content.split(CODE_SPAN_PATTERN)
  const localized = segments.map((segment) => {
    if (segment.startsWith('`')) return segment

    let value = segment
    if (!actionMatched) {
      for (const [pattern, replacement] of ACTION_REPLACEMENTS) {
        if (!pattern.test(value)) continue
        value = value.replace(pattern, replacement)
        actionMatched = true
        break
      }
    }

    if (!actionMatched) return value
    for (const [pattern, replacement] of PHRASE_REPLACEMENTS) {
      value = value.replace(pattern, replacement)
    }
    value = value.replace(/^([\u3400-\u9fff]+)\s+(?=[\u3400-\u9fff])/u, '$1')
    return value
  })

  return `${prefix}${localized.join('')}${suffix}`
}

export function localizeLiveReasoningText(text: string): string {
  const normalized = text.replace(/\*{4}(?=\S)/gu, '**\n**')
  return normalized.split('\n').map(localizeReasoningLine).join('\n')
}
