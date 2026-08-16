import { describe, expect, it } from 'vitest'
import { normalizeDeepSeekApiKey } from '../src/credentials.ts'

describe('DeepSeek API key input', () => {
  it('accepts a pasted key value and trims surrounding whitespace', () => {
    expect(normalizeDeepSeekApiKey('  sk-test-123  ')).toBe('sk-test-123')
  })

  it('rejects an empty value', () => {
    expect(() => normalizeDeepSeekApiKey('   ')).toThrow('Paste or enter')
  })

  it('rejects a pasted environment assignment', () => {
    expect(() => normalizeDeepSeekApiKey('DEEPSEEK_API_KEY=sk-test')).toThrow('only the API key value')
  })

  it('rejects surrounding quotes and non-printable characters', () => {
    expect(() => normalizeDeepSeekApiKey('"sk-test"')).toThrow('without surrounding quotes')
    expect(() => normalizeDeepSeekApiKey('sk-test\nsecond-line')).toThrow('printable ASCII')
  })
})
