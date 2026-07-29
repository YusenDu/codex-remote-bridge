import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const PUBLIC_BRIDGE_URL = 'https://120.48.173.147'

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8')

describe('public bridge endpoint consistency', () => {
  it('uses the trusted IP endpoint in the desktop defaults and embedded UI', () => {
    const config = read('apps/desktop-agent/src-tauri/src/config.rs')
    const library = read('apps/desktop-agent/src-tauri/src/lib.rs')
    const script = read('apps/desktop-agent/web/app.js')
    const markup = read('apps/desktop-agent/web/index.html')

    expect(config).toContain(`const PUBLIC_BRIDGE_URL: &str = "${PUBLIC_BRIDGE_URL}"`)
    expect(library).toContain(`server_url: "${PUBLIC_BRIDGE_URL}".into()`)
    expect(library).toContain(`web_url: "${PUBLIC_BRIDGE_URL}/".into()`)
    expect(script).toContain(`serverUrl: '${PUBLIC_BRIDGE_URL}'`)
    expect(script).toContain(`webUrl: '${PUBLIC_BRIDGE_URL}/'`)
    expect(markup).toContain(`placeholder="${PUBLIC_BRIDGE_URL}"`)
    expect(markup).toContain(`placeholder="${PUBLIC_BRIDGE_URL}/"`)
  })
})
