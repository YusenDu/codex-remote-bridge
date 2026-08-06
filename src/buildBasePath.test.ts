import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('Vite deployment base path', () => {
  it('builds assets relative to the mounted application path', () => {
    const config = readFileSync(new URL('../vite.config.ts', import.meta.url), 'utf8')

    expect(config).toMatch(/base:\s*["']\.\/["']/)
  })
})
