import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { findSourceRoot, parseDshWebUrl, resolveLaunch, webArgsForDshVersion } from '../src/launch.ts'

describe('DSH launch resolution', () => {
  it('recognizes only the official web URL announcement', () => {
    expect(parseDshWebUrl('dsh web: http://127.0.0.1:43127')).toBe('http://127.0.0.1:43127')
    expect(parseDshWebUrl('info dsh web: http://127.0.0.1:8080 (LAN: ignored)')).toBe('http://127.0.0.1:8080')
    expect(parseDshWebUrl('server listening at http://127.0.0.1:43127')).toBeUndefined()
    expect(parseDshWebUrl('dsh web: https://example.com')).toBeUndefined()
  })

  it('suppresses the rc.8 browser handoff while preserving older DSH launches', () => {
    const args = ['web', '--host', '127.0.0.1', '--port', '0']
    expect(webArgsForDshVersion(args, '0.1.0-rc.7')).toEqual(args)
    expect(webArgsForDshVersion(args, '0.1.0-rc.8')).toEqual([...args, '--no-open'])
    expect(webArgsForDshVersion(args, '0.1.0')).toEqual([...args, '--no-open'])
    expect(webArgsForDshVersion([...args, '--no-open'], '0.1.0-rc.8')).toEqual([...args, '--no-open'])
    expect(webArgsForDshVersion(['--profile', 'web', '--port', '0'], 'dsh 0.1.0-rc.8'))
      .toEqual(['--profile', 'web', '--port', '0', '--no-open'])
  })

  it('finds the official source checkout and launches its real CLI entry', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-vscode-source-'))
    mkdirSync(join(root, 'apps', 'cli', 'src'), { recursive: true })
    mkdirSync(join(root, 'apps', 'vscode'), { recursive: true })
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-root' }))
    writeFileSync(join(root, 'apps', 'cli', 'src', 'bin.ts'), '')

    expect(findSourceRoot(join(root, 'apps', 'vscode'))).toBe(root)
    const launch = resolveLaunch(join(root, 'apps', 'vscode'), '', ['web', '--port', '0'])
    expect(launch.sourceCheckout).toBe(true)
    expect(launch.command).toBe(process.execPath)
    expect(launch.env).toEqual({
      ELECTRON_RUN_AS_NODE: '1',
      TSX_TSCONFIG_PATH: join(root, 'tsconfig.json'),
    })
    expect(launch.args).toEqual([
      '--import',
      'tsx/esm',
      join(root, 'apps', 'cli', 'src', 'bin.ts'),
      'web',
      '--port',
      '0',
    ])
  })

  it('honors an explicit executable without adding a mock or wrapper mode', () => {
    expect(resolveLaunch('/not/a/source/tree', '/opt/dsh', ['web'])).toEqual({
      command: '/opt/dsh',
      args: ['web'],
      sourceCheckout: false,
    })
  })

  it('falls back to the installed DSH executable outside a source checkout', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-vscode-installed-'))
    expect(resolveLaunch(root, '', ['web'])).toEqual({
      command: process.platform === 'win32' ? 'dsh.cmd' : 'dsh',
      args: ['web'],
      sourceCheckout: false,
    })
  })
})
