import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
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
    expect(webArgsForDshVersion(args, 'v0.1.0-rc.8')).toEqual([...args, '--no-open'])
    expect(webArgsForDshVersion(args, '0.1.0-rc.8+build.5')).toEqual([...args, '--no-open'])
    expect(webArgsForDshVersion(args, 'v0.1.0-rc.7')).toEqual(args)
  })

  it('keeps suppressing the browser handoff on the 0.1.1 release candidates and later', () => {
    const args = ['web', '--host', '127.0.0.1', '--port', '0']
    expect(webArgsForDshVersion(args, '0.1.1-rc.1')).toEqual([...args, '--no-open'])
    expect(webArgsForDshVersion(args, '0.1.1-rc.2')).toEqual([...args, '--no-open'])
    expect(webArgsForDshVersion(args, '0.1.1')).toEqual([...args, '--no-open'])
    expect(webArgsForDshVersion(args, '0.2.0-rc.1')).toEqual([...args, '--no-open'])
    expect(webArgsForDshVersion(args, '1.0.0')).toEqual([...args, '--no-open'])
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
    expect(resolveLaunch('/not/a/source/tree', '/opt/dsh', ['web'], { platform: 'linux' })).toEqual({
      command: '/opt/dsh',
      args: ['web'],
      sourceCheckout: false,
    })
  })

  it('falls back to the installed DSH executable outside a source checkout', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-vscode-installed-'))
    expect(resolveLaunch(root, '', ['web'], { platform: 'linux' })).toEqual({
      command: 'dsh',
      args: ['web'],
      sourceCheckout: false,
    })
  })

  it('routes an explicitly configured dsh command through cmd.exe on Windows', () => {
    expect(resolveLaunch('/not/a/source/tree', 'dsh', ['web'], {
      platform: 'win32',
      env: { ComSpec: 'C:\\Windows\\System32\\cmd.exe' },
    })).toEqual({
      command: 'C:\\Windows\\System32\\cmd.exe',
      args: ['/d', '/s', '/c', '"dsh ^"web^""'],
      sourceCheckout: false,
      windowsVerbatimArguments: true,
    })
  })

  it('resolves an explicitly configured npm dsh command from PATH on Windows', () => {
    const prefix = mkdtempSync(join(tmpdir(), 'dsh-vscode-windows-explicit-name-'))
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

    expect(resolveLaunch('/not/a/source/tree', 'dsh', ['web'], {
      platform: 'win32',
      env: { Path: prefix },
    })).toEqual({
      command: node,
      args: [entry, 'web'],
      sourceCheckout: false,
    })
  })

  it('preserves the first PATH match instead of skipping an earlier dsh.exe', () => {
    const nativePrefix = mkdtempSync(join(tmpdir(), 'dsh-vscode-windows-native-'))
    const npmPrefix = mkdtempSync(join(tmpdir(), 'dsh-vscode-windows-npm-'))
    const native = join(nativePrefix, 'dsh.exe')
    const packageRoot = join(npmPrefix, 'node_modules', '@deepseek-ai', 'dsh')
    mkdirSync(join(packageRoot, 'lib'), { recursive: true })
    writeFileSync(native, '')
    writeFileSync(join(npmPrefix, 'dsh.cmd'), '@echo off\r\n')
    writeFileSync(join(npmPrefix, 'node.exe'), '')
    writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({
      name: '@deepseek-ai/dsh',
      bin: { dsh: 'lib/bin.js' },
    }))
    writeFileSync(join(packageRoot, 'lib', 'bin.js'), '')

    expect(resolveLaunch('/not/a/source/tree', 'dsh', ['web'], {
      platform: 'win32',
      env: { Path: `${nativePrefix};${npmPrefix}`, PATHEXT: '.EXE;.CMD' },
    })).toEqual({
      command: native,
      args: ['web'],
      sourceCheckout: false,
    })
  })

  it('routes non-native PATHEXT matches through cmd.exe', () => {
    const prefix = mkdtempSync(join(tmpdir(), 'dsh-vscode-windows-script-'))
    const script = join(prefix, 'dsh.js')
    writeFileSync(script, '')

    const launch = resolveLaunch('/not/a/source/tree', 'dsh', ['web'], {
      platform: 'win32',
      env: { Path: prefix, PATHEXT: '.JS;.EXE', ComSpec: 'C:\\Windows\\System32\\cmd.exe' },
    })

    expect(launch).toEqual({
      command: 'C:\\Windows\\System32\\cmd.exe',
      args: ['/d', '/s', '/c', `"${script} ^"web^""`],
      sourceCheckout: false,
      windowsVerbatimArguments: true,
    })
  })

  it('resolves the current directory before PATH like cmd.exe', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'dsh-vscode-windows-cwd-'))
    const pathPrefix = mkdtempSync(join(tmpdir(), 'dsh-vscode-windows-path-'))
    const local = join(workspace, 'dsh.exe')
    writeFileSync(local, '')
    writeFileSync(join(pathPrefix, 'dsh.exe'), '')

    expect(resolveLaunch('/not/a/source/tree', 'dsh', ['web'], {
      platform: 'win32',
      cwd: workspace,
      env: { Path: pathPrefix, PATHEXT: '.EXE' },
    })).toEqual({
      command: local,
      args: ['web'],
      sourceCheckout: false,
    })
  })

  it('rejects newline injection before building a cmd.exe fallback', () => {
    expect(() => resolveLaunch('/not/a/source/tree', 'dsh', ['safe\r\necho injected'], {
      platform: 'win32',
      env: { Path: '', ComSpec: 'cmd.exe' },
    })).toThrow('cannot contain NUL or newline')
  })

  it.runIf(process.platform === 'win32')('preserves cmd.exe metacharacters as literal arguments', () => {
    const prefix = mkdtempSync(join(tmpdir(), 'dsh-vscode-windows-shell-'))
    const shim = join(prefix, 'dsh.cmd')
    const capture = join(prefix, 'capture.cjs')
    writeFileSync(capture, 'process.stdout.write(JSON.stringify(process.argv.slice(2)))\n')
    writeFileSync(shim, `@echo off\r\n"${process.execPath}" "%~dp0capture.cjs" %*\r\n`)
    const unsafeLooking = [
      'space value',
      'tab\tvalue',
      'value&echo SHOULD_NOT_RUN',
      'pipe|findstr x',
      'left<missing.txt',
      'right>captured.txt',
      '(group)',
      'caret^value',
      'percent%PATH%value',
      'bang!value',
      'quote"value',
      'trailing\\',
      '',
    ]
    const launch = resolveLaunch('/not/a/source/tree', shim, unsafeLooking, {
      platform: 'win32',
      env: process.env,
    })
    const result = spawnSync(launch.command, launch.args, {
      encoding: 'utf8',
      windowsHide: true,
      windowsVerbatimArguments: launch.windowsVerbatimArguments,
    })

    expect(result.error).toBeUndefined()
    expect(result.status, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual(unsafeLooking)
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

  it('routes the PATH fallback through cmd.exe when a Windows install cannot be resolved', () => {
    const prefix = mkdtempSync(join(tmpdir(), 'dsh-vscode-windows-missing-'))
    expect(resolveLaunch('/not/a/source/tree', '', ['web'], {
      platform: 'win32',
      env: { Path: prefix, ComSpec: 'C:\\Windows\\System32\\cmd.exe' },
    })).toEqual({
      command: 'C:\\Windows\\System32\\cmd.exe',
      args: ['/d', '/s', '/c', '"dsh ^"web^""'],
      sourceCheckout: false,
      windowsVerbatimArguments: true,
    })
  })

  it('defaults to cmd.exe when ComSpec is unset for the Windows fallback', () => {
    const prefix = mkdtempSync(join(tmpdir(), 'dsh-vscode-windows-nocomspec-'))
    expect(resolveLaunch('/not/a/source/tree', '', ['web'], {
      platform: 'win32',
      env: { Path: prefix },
    })).toEqual({
      command: 'cmd.exe',
      args: ['/d', '/s', '/c', '"dsh ^"web^""'],
      sourceCheckout: false,
      windowsVerbatimArguments: true,
    })
  })

  it('resolves a relative explicit dsh.cmd against the workspace before invoking cmd.exe', () => {
    const prefix = mkdtempSync(join(tmpdir(), 'dsh-vscode-windows-relative-'))
    expect(resolveLaunch('/not/a/source/tree', 'tools/dsh.cmd', ['web'], {
      platform: 'win32',
      cwd: prefix,
      env: { ComSpec: 'cmd.exe' },
    })).toEqual({
      command: 'cmd.exe',
      args: ['/d', '/s', '/c', `"${join(prefix, 'tools', 'dsh.cmd')} ^"web^""`],
      sourceCheckout: false,
      windowsVerbatimArguments: true,
    })
  })

  it('routes an unresolvable explicit dsh.cmd through cmd.exe on Windows', () => {
    const prefix = mkdtempSync(join(tmpdir(), 'dsh-vscode-windows-explicit-missing-'))
    const cmdPath = join(prefix, 'dsh.cmd')
    writeFileSync(cmdPath, '@echo off\r\n')
    expect(resolveLaunch('/not/a/source/tree', cmdPath, ['web'], {
      platform: 'win32',
      env: { ComSpec: 'cmd.exe' },
    })).toEqual({
      command: 'cmd.exe',
      args: ['/d', '/s', '/c', `"${cmdPath} ^"web^""`],
      sourceCheckout: false,
      windowsVerbatimArguments: true,
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
