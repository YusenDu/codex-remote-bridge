import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('PlanProgressPopover component contract', () => {
  const source = readFileSync(new URL('./PlanProgressPopover.vue', import.meta.url), 'utf8')

  it('uses an accessible progress trigger', () => {
    expect(source).toMatch(/<button[\s\S]*class="plan-progress-trigger"/u)
    expect(source).toContain('aria-expanded')
    expect(source).toContain('aria-controls')
    expect(source).toContain('role="progressbar"')
    expect(source).toContain('aria-valuenow')
    expect(source).toContain('aria-valuemax')
  })

  it('supports pointer, keyboard focus, and touch-friendly click interaction', () => {
    expect(source).toContain('@pointerenter="openPopover"')
    expect(source).toContain('@pointerleave="onPointerLeave"')
    expect(source).toContain('@focusin="openPopover"')
    expect(source).toContain('@focusout="onFocusOut"')
    expect(source).toContain('@click="togglePopover"')
  })

  it('opens upward without changing composer layout and constrains mobile width', () => {
    expect(source).toMatch(/\.plan-progress-popover[\s\S]*position:\s*absolute/u)
    expect(source).toMatch(/\.plan-progress-popover[\s\S]*bottom:\s*calc\(100%/u)
    expect(source).toContain('max-width: calc(100vw - 2rem)')
    expect(source).toContain('overflow-wrap: anywhere')
  })
})
