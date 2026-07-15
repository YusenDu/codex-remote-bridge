import { afterEach, describe, expect, it } from 'vitest'
import { setUiLanguage, t } from './useUiLanguage'

afterEach(() => {
  setUiLanguage('en')
})

describe('reasoning effort translations', () => {
  it('translates every reasoning effort label in the Chinese UI', () => {
    setUiLanguage('zh-CN')

    expect([
      t('None'),
      t('Minimal'),
      t('Low'),
      t('Medium'),
      t('High'),
      t('Extra high'),
    ]).toEqual(['无', '最低', '低', '中', '高', '超高'])
  })
})
