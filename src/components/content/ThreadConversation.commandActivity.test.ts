import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('ThreadConversation command activity contract', () => {
  const source = readFileSync(new URL('./ThreadConversation.vue', import.meta.url), 'utf8')

  it('renders grouped commands as a localized tool activity card', () => {
    expect(source).toContain('class="command-activity"')
    expect(source).toContain('class="command-activity-title">命令活动</span>')
    expect(source).toContain('commandGroupCountLabel(message)')
    expect(source).toContain('commandGroupCompositionLabel(message)')
    expect(source).toContain('commandGroupStatusLabel(message)')
    expect(source).toContain('<IconTablerTerminal')
  })

  it('keeps per-command expansion and output in the activity card', () => {
    expect(source).toContain('class="command-activity-row"')
    expect(source).toContain('toggleCommandExpand(cmd)')
    expect(source).toContain('getCommandBlockForLatest(message)')
    expect(source).toContain('commandStatusLabel(message)')
  })

  it('does not use the old command count summary copy', () => {
    expect(source).not.toContain('commands · latest:')
  })

  it('treats completed commands without an exit code as successful tool events', () => {
    expect(source).toContain('execution.exitCode != null && execution.exitCode !== 0')
    expect(source).toContain('ce.exitCode == null || ce.exitCode === 0')
  })
})
