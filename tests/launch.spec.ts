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

  it('launches an npm-installed DSH entry directly on Windows', () => {
    const prefix = mkdtempSync(join(tmpdir(), 'dsh-vscode-windows-prefix-'))
    const packageRoot = join(prefix, 'node_modules', '@deepseek-ai', 'dsh')
    const entry = join(packageRoot, 'lib', 'bin.js')
    const node = join(prefix, 'node.exe')
    mkdirSync(join(packageRoot, 'lib'), { recursive: true })
    writeFileSync(join(prefix, 'dsh.cmd'), '@echo off\r\n')
    writeFileSync(node, '')
    writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({
      name: '@deepseek-ai/dsh',
      bin: { dsh: 'lib/bin.js' },
    }))
    writeFileSync(entry, '')

    expect(resolveLaunch('/not/a/source/tree', '', ['web', '--port', '0'], {
      platform: 'win32',
      env: { Path: prefix },
    })).toEqual({
      command: node,
      args: [entry, 'web', '--port', '0'],
      sourceCheckout: false,
    })
  })

  it('uses the Node runtime that npm shims would resolve from PATH', () => {
    const prefix = mkdtempSync(join(tmpdir(), 'dsh-vscode-windows-prefix-'))
    const nodeDirectory = mkdtempSync(join(tmpdir(), 'dsh-vscode-windows-node-'))
    const packageRoot = join(prefix, 'node_modules', '@deepseek-ai', 'dsh')
    const entry = join(packageRoot, 'lib', 'bin.js')
    const node = join(nodeDirectory, 'node.exe')
    mkdirSync(join(packageRoot, 'lib'), { recursive: true })
    writeFileSync(join(prefix, 'dsh.cmd'), '@echo off\r\n')
    writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({
      name: '@deepseek-ai/dsh',
      bin: { dsh: 'lib/bin.js' },
    }))
    writeFileSync(entry, '')
    writeFileSync(node, '')

    expect(resolveLaunch('/not/a/source/tree', '', ['web'], {
      platform: 'win32',
      env: { Path: `${prefix};${nodeDirectory}` },
    })).toEqual({
      command: node,
      args: [entry, 'web'],
      sourceCheckout: false,
    })
  })

  it('keeps the dsh.cmd fallback when a Windows install cannot be resolved safely', () => {
    const prefix = mkdtempSync(join(tmpdir(), 'dsh-vscode-windows-missing-'))
    expect(resolveLaunch('/not/a/source/tree', '', ['web'], {
      platform: 'win32',
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
    const node = join(prefix, 'node.exe')
    mkdirSync(join(packageRoot, 'lib'), { recursive: true })
    writeFileSync(join(prefix, 'dsh.cmd'), '@echo off\r\n')
    writeFileSync(node, '')
    writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({
      name: '@deepseek-ai/dsh',
      bin: 'lib/bin.js',
    }))
    writeFileSync(entry, '')

    expect(resolveLaunch('/not/a/source/tree', join(prefix, 'dsh.cmd'), ['web'], {
      platform: 'win32',
      env: {},
    })).toEqual({
      command: node,
      args: [entry, 'web'],
      sourceCheckout: false,
    })
  })

  it('resolves an explicitly configured relative dsh.cmd from the launch cwd', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'dsh-vscode-windows-workspace-'))
    const relativePrefix = join(workspace, 'tools')
    const globalPrefix = mkdtempSync(join(tmpdir(), 'dsh-vscode-windows-global-'))
    const relativePackage = join(relativePrefix, 'node_modules', '@deepseek-ai', 'dsh')
    const globalPackage = join(globalPrefix, 'node_modules', '@deepseek-ai', 'dsh')
    const relativeEntry = join(relativePackage, 'lib', 'bin.js')
    mkdirSync(join(relativePackage, 'lib'), { recursive: true })
    mkdirSync(join(globalPackage, 'lib'), { recursive: true })
    for (const [prefix, packageRoot] of [[relativePrefix, relativePackage], [globalPrefix, globalPackage]]) {
      writeFileSync(join(prefix, 'dsh.cmd'), '@echo off\r\n')
      writeFileSync(join(prefix, 'node.exe'), '')
      writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({
        name: '@deepseek-ai/dsh',
        bin: { dsh: 'lib/bin.js' },
      }))
      writeFileSync(join(packageRoot, 'lib', 'bin.js'), '')
    }

    expect(resolveLaunch('/not/a/source/tree', 'tools\\dsh.cmd', ['web'], {
      platform: 'win32',
      cwd: workspace,
      env: { Path: globalPrefix },
    })).toEqual({
      command: join(relativePrefix, 'node.exe'),
      args: [relativeEntry, 'web'],
      sourceCheckout: false,
    })
  })
})
