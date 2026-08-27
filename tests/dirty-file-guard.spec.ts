import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { comparableFilePath } from '../src/file-path.ts'

describe('comparableFilePath', () => {
  const temporaryDirectories: string[] = []
  afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
  })

  function temporaryDirectory(): string {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-vscode-path-'))
    temporaryDirectories.push(directory)
    return directory
  }

  it('uses the real filesystem identity for differently cased aliases', () => {
    const directory = temporaryDirectory()
    const actual = path.join(directory, 'MixedCase.ts')
    const alias = path.join(directory, 'mixedcase.ts')
    fs.writeFileSync(actual, '')

    if (fs.existsSync(alias)) {
      expect(comparableFilePath(alias)).toBe(comparableFilePath(actual))
    } else {
      expect(comparableFilePath(alias)).not.toBe(comparableFilePath(actual))
    }
  })

  it('preserves distinct files on a case-sensitive filesystem', () => {
    const directory = temporaryDirectory()
    const upper = path.join(directory, 'App.ts')
    const lower = path.join(directory, 'app.ts')
    fs.writeFileSync(upper, 'upper')
    fs.writeFileSync(lower, 'lower')
    if (fs.readFileSync(upper, 'utf8') !== 'upper') return

    expect(comparableFilePath(upper)).not.toBe(comparableFilePath(lower))
  })

  it('does not fold the case of paths that do not exist yet', () => {
    const directory = temporaryDirectory()
    expect(comparableFilePath(path.join(directory, 'Future.ts'))).not.toBe(
      comparableFilePath(path.join(directory, 'future.ts')),
    )
  })
})
