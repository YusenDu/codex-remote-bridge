import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('project root suggestion behavior', () => {
  it('requests a suggestion only while opening the create-project modal', () => {
    const appSource = readFileSync(new URL('./App.vue', import.meta.url), 'utf8')
    const calls = appSource.match(/(?:void|await) refreshDefaultProjectName\([^)]*\)/gu) ?? []

    expect(calls).toHaveLength(1)
    expect(appSource).toMatch(
      /async function onOpenProjectSetupModal\(\)[\s\S]*?await refreshDefaultProjectName\(baseDir\)/u,
    )
  })
})
