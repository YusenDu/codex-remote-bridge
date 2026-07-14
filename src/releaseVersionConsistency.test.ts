import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const RELEASE_VERSION = '0.1.90'
const ESCAPED_RELEASE_VERSION = RELEASE_VERSION.replace(/\./gu, '\\.')

function read(path: string): string {
  return readFileSync(new URL(path, import.meta.url), 'utf8')
}

function packageVersion(path: string): string {
  return (JSON.parse(read(path)) as { version?: string }).version ?? ''
}

describe('release version consistency', () => {
  it('uses one version for Web, desktop npm, Tauri, and Rust manifests', () => {
    expect(packageVersion('../package.json')).toBe(RELEASE_VERSION)
    expect(packageVersion('../apps/desktop-agent/package.json')).toBe(RELEASE_VERSION)
    expect(packageVersion('../apps/desktop-agent/src-tauri/tauri.conf.json')).toBe(RELEASE_VERSION)
    expect(read('../apps/desktop-agent/src-tauri/Cargo.toml')).toMatch(
      new RegExp(`^version = "${ESCAPED_RELEASE_VERSION}"$`, 'mu'),
    )
    expect(read('../apps/desktop-agent/src-tauri/Cargo.lock')).toMatch(
      new RegExp(`name = "codex-bridge-agent"\\r?\\nversion = "${ESCAPED_RELEASE_VERSION}"`, 'u'),
    )
  })

  it('uses the release version in the embedded desktop UI and preview adapter', () => {
    const html = read('../apps/desktop-agent/web/index.html')
    const script = read('../apps/desktop-agent/web/app.js')

    expect(html).toContain(`v${RELEASE_VERSION}`)
    expect(script).toContain(`currentVersion: '${RELEASE_VERSION}'`)
    expect(script).toContain(`latestVersion: '${RELEASE_VERSION}'`)
    expect(script).toContain(`releases/tag/v${RELEASE_VERSION}`)
    expect(script).toContain(`return '${RELEASE_VERSION}'`)
  })
})
