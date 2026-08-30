import { describe, expect, it } from 'vitest'
import { setupKindFor } from '../src/setup-state.ts'

describe('setup state', () => {
  it('asks for a workspace before attempting runtime setup', () => {
    expect(setupKindFor('', 'error', 'spawn dsh ENOENT')).toBe('workspace')
  })

  it('recognizes common missing DSH launch errors', () => {
    expect(setupKindFor('/workspace', 'error', 'spawn dsh ENOENT')).toBe('dsh')
    expect(setupKindFor('/workspace', 'error', 'dsh is not recognized as an internal command')).toBe('dsh')
  })

  it('recognizes credential errors without overriding healthy states', () => {
    expect(setupKindFor('/workspace', 'error', 'DEEPSEEK_API_KEY is required')).toBe('api-key')
    expect(setupKindFor('/workspace', 'ready', 'API key is required')).toBeNull()
  })

  it('leaves unrelated runtime failures on the generic recovery path', () => {
    expect(setupKindFor('/workspace', 'error', 'Lost the DSH event stream')).toBeNull()
  })
})
