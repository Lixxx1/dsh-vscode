import { describe, expect, it } from 'vitest'
import { compactDebugText, debugVariableValue, launchConfigurationNames } from '../src/debug-values.ts'

describe('debug tool values', () => {
  it('selects only named static launch and attach configurations', () => {
    expect(launchConfigurationNames([
      { name: 'Launch app', type: 'node', request: 'launch' },
      { name: 'Attach app', type: 'node', request: 'attach' },
      { name: 'Launch app', type: 'python', request: 'launch' },
      { name: '', type: 'node', request: 'launch' },
      { name: 'Compound-like', configurations: ['Launch app'] },
    ])).toEqual(['Launch app', 'Attach app'])
  })

  it('redacts sensitive values by variable name', () => {
    expect(debugVariableValue('api_key', 'sk-secret', 'string', 0)).toEqual({
      name: 'api_key',
      value: '<redacted>',
      type: 'string',
      expandable: false,
    })
    expect(debugVariableValue('userPassword', 'hidden', undefined, 0).value).toBe('<redacted>')
    expect(debugVariableValue('session_token', 'secret', undefined, 3).expandable).toBe(true)
  })

  it('keeps debugger output single-line and bounded', () => {
    expect(compactDebugText('one\n\ttwo', 20)).toBe('one two')
    expect(compactDebugText('1234567890', 6)).toBe('12345…')
  })
})
