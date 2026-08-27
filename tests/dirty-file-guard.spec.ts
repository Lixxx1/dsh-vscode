import { describe, expect, it } from 'vitest'
import { comparableFilePath } from '../src/file-path.ts'

describe('comparableFilePath', () => {
  it('compares Windows paths without case sensitivity', () => {
    expect(comparableFilePath('C:\\Repo\\App.ts', 'win32')).toBe(
      comparableFilePath('c:\\repo\\app.ts', 'win32'),
    )
  })

  it('preserves case on case-sensitive platforms', () => {
    expect(comparableFilePath('/repo/App.ts', 'linux')).not.toBe(
      comparableFilePath('/repo/app.ts', 'linux'),
    )
  })
})
