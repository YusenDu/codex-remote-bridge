import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

describe('public device entry route', () => {
  it('keeps the machine code in the address instead of redirecting to the root', () => {
    const source = readFileSync(fileURLToPath(new URL('./index.ts', import.meta.url)), 'utf8')

    expect(source).toContain("path: '/device/:deviceId'")
    expect(source).toContain("path: '/device/:deviceId/thread/:threadId'")
    expect(source).toContain('setActiveDeviceId(to.params.deviceId)')
    expect(source).not.toContain("return { name: 'home' }")
  })

  it('waits for the device entry route before mounting the application', () => {
    const source = readFileSync(fileURLToPath(new URL('../main.ts', import.meta.url)), 'utf8')

    expect(source).toContain("router.isReady().then(() => app.mount('#app'))")
  })
})
