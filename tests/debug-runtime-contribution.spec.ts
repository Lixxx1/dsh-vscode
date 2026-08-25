import { describe, expect, it } from 'vitest'
import { supportsDebugRuntime } from '../src/debug-runtime-patch.ts'

describe('debug runtime compatibility', () => {
  it('accepts rc.8, stable releases, and unknown custom executables', () => {
    expect(supportsDebugRuntime('0.1.0-rc.7')).toBe(false)
    expect(supportsDebugRuntime('dsh 0.1.0-rc.8')).toBe(true)
    expect(supportsDebugRuntime('0.1.0')).toBe(true)
    expect(supportsDebugRuntime('0.1.1-rc.1')).toBe(true)
    expect(supportsDebugRuntime('1.0.0')).toBe(true)
    expect(supportsDebugRuntime(undefined)).toBe(true)
    expect(supportsDebugRuntime('custom build')).toBe(true)
  })
})
