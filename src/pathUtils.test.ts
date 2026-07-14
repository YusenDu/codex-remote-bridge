import { describe, expect, it } from 'vitest'
import { getPathParent } from './pathUtils'

describe('getPathParent', () => {
  it('preserves an absolute Windows drive root', () => {
    expect(getPathParent('K:\\codex-mcp')).toBe('K:\\')
    expect(getPathParent('K:\\')).toBe('K:\\')
  })
})
