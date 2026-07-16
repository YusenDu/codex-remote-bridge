import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('ThreadConversation live reasoning contract', () => {
  const source = readFileSync(new URL('./ThreadConversation.vue', import.meta.url), 'utf8')

  it('renders live reasoning through the escaped markdown renderer', () => {
    expect(source).toMatch(
      /class="live-overlay-reasoning"[\s\S]*v-html="renderMarkdownBlocksAsHtml\(localizedLiveReasoningText\)"/u,
    )
    expect(source).not.toContain('{{ liveOverlay.reasoningText }}')
  })

  it('localizes live activity labels and reasoning only at render time', () => {
    expect(source).toContain('localizeLiveActivityLabel(props.liveOverlay?.activityLabel ??')
    expect(source).toContain('localizeLiveReasoningText(props.liveOverlay?.reasoningText ??')
  })

  it('routes desktop-local images through the active thread and device', () => {
    expect(source).toContain(':src="toRenderableImageUrl(imageUrl)"')
    expect(source).toContain(':src="toRenderableImageUrl(block.url)"')
    expect(source).toMatch(/routeLocalImageUrl\([^,]+, props\.activeThreadId\)/u)
  })
})
