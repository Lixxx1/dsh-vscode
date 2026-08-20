import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { findSourceRoot, parseDshWebUrl, resolveLaunch } from '../src/launch.ts'

describe('DSH launch resolution', () => {
  it('recognizes only the official web URL announcement', () => {
    expect(parseDshWebUrl('dsh web: http://127.0.0.1:43127')).toBe('http://127.0.0.1:43127')
    expect(parseDshWebUrl('info dsh web: http://127.0.0.1:8080 (LAN: ignored)')).toBe('http://127.0.0.1:8080')
    expect(parseDshWebUrl('server listening at http://127.0.0.1:43127')).toBeUndefined()
    expect(parseDshWebUrl('dsh web: https://example.com')).toBeUndefined()
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

  it('launches an npm-installed DSH entry directly on Windows', () => {
    const prefix = mkdtempSync(join(tmpdir(), 'dsh-vscode-windows-prefix-'))
    const packageRoot = join(prefix, 'node_modules', '@deepseek-ai', 'dsh')
    const entry = join(packageRoot, 'lib', 'bin.js')
    mkdirSync(join(packageRoot, 'lib'), { recursive: true })
    writeFileSync(join(prefix, 'dsh.cmd'), '@echo off\r\n')
    writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({
      name: '@deepseek-ai/dsh',
      bin: { dsh: 'lib/bin.js' },
    }))
    writeFileSync(entry, '')

    expect(resolveLaunch('/not/a/source/tree', '', ['web', '--port', '0'], {
      platform: 'win32',
      execPath: 'C:\\Program Files\\Microsoft VS Code\\Code.exe',
      env: { Path: prefix },
    })).toEqual({
      command: 'C:\\Program Files\\Microsoft VS Code\\Code.exe',
      args: [entry, 'web', '--port', '0'],
      sourceCheckout: false,
      env: { ELECTRON_RUN_AS_NODE: '1' },
    })
  })

  it('keeps the dsh.cmd fallback when a Windows install cannot be resolved safely', () => {
    const prefix = mkdtempSync(join(tmpdir(), 'dsh-vscode-windows-missing-'))
    expect(resolveLaunch('/not/a/source/tree', '', ['web'], {
      platform: 'win32',
      execPath: 'C:\\Program Files\\Microsoft VS Code\\Code.exe',
      env: { Path: prefix },
    })).toEqual({
      command: 'dsh.cmd',
      args: ['web'],
      sourceCheckout: false,
    })
  })

  it('resolves an explicitly configured npm dsh.cmd on Windows', () => {
    const prefix = mkdtempSync(join(tmpdir(), 'dsh-vscode-windows-explicit-'))
    const packageRoot = join(prefix, 'node_modules', '@deepseek-ai', 'dsh')
    const entry = join(packageRoot, 'lib', 'bin.js')
    mkdirSync(join(packageRoot, 'lib'), { recursive: true })
    writeFileSync(join(prefix, 'dsh.cmd'), '@echo off\r\n')
    writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({
      name: '@deepseek-ai/dsh',
      bin: 'lib/bin.js',
    }))
    writeFileSync(entry, '')

    expect(resolveLaunch('/not/a/source/tree', join(prefix, 'dsh.cmd'), ['web'], {
      platform: 'win32',
      execPath: 'C:\\Program Files\\Microsoft VS Code\\Code.exe',
      env: {},
    })).toEqual({
      command: 'C:\\Program Files\\Microsoft VS Code\\Code.exe',
      args: [entry, 'web'],
      sourceCheckout: false,
      env: { ELECTRON_RUN_AS_NODE: '1' },
    })
  })
})
