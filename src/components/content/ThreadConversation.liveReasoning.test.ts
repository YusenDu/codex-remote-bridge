import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('ThreadConversation live reasoning contract', () => {
  const source = readFileSync(new URL('./ThreadConversation.vue', import.meta.url), 'utf8')

  it('renders live reasoning through the escaped markdown renderer', () => {
    expect(source).toMatch(
      /class="live-overlay-reasoning"[\s\S]*v-html="renderMarkdownBlocksAsHtml\(liveOverlay\.reasoningText\)"/u,
    )
    expect(source).not.toContain('{{ liveOverlay.reasoningText }}')
  })
})
