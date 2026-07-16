import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('command activity dark theme contract', () => {
  const source = readFileSync(new URL('./style.css', import.meta.url), 'utf8')

  it('uses the application root theme selector for command activity cards', () => {
    expect(source).toContain(':root.dark .command-activity {')
    expect(source).toContain(':root.dark .command-activity-body {')
    expect(source).toContain(':root.dark .command-activity-row:hover,')
  })
})
