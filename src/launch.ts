import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export interface LaunchCommand {
  command: string
  args: string[]
  sourceCheckout: boolean
  env?: Readonly<Record<string, string>>
}

interface LaunchHost {
  platform: NodeJS.Platform
  env: Readonly<Record<string, string | undefined>>
  cwd: string
}

const SOURCE_ROOT_PACKAGE = '@deepseek-ai/dsh-root'
const INSTALLED_PACKAGE = '@deepseek-ai/dsh'

function hostPath(env: Readonly<Record<string, string | undefined>>): string {
  for (const [key, value] of Object.entries(env)) {
    if (key.toLowerCase() === 'path') return value ?? ''
  }
  return ''
}

function windowsPathDirectories(env: Readonly<Record<string, string | undefined>>): string[] {
  return hostPath(env)
    .split(';')
    .map(value => value.trim().replace(/^"|"$/g, ''))
    .filter(value => value !== '')
}

function executableBasename(executable: string): string {
  return executable.split(/[\\/]/).at(-1) ?? executable
}

function explicitExecutablePath(executable: string, cwd: string): string {
  if (isAbsolute(executable)) return executable
  return resolve(cwd, ...executable.split(/[\\/]+/))
}

function installedDshEntry(binDirectory: string): string | undefined {
  const packageRoot = join(binDirectory, 'node_modules', '@deepseek-ai', 'dsh')
  const manifestPath = join(packageRoot, 'package.json')
  if (!existsSync(manifestPath)) return undefined

  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      name?: unknown
      bin?: unknown
    }
    if (manifest.name !== INSTALLED_PACKAGE) return undefined
    const bin = typeof manifest.bin === 'string'
      ? manifest.bin
      : typeof manifest.bin === 'object' && manifest.bin !== null
        ? (manifest.bin as Record<string, unknown>).dsh
        : undefined
    if (typeof bin !== 'string') return undefined
    const entry = resolve(packageRoot, bin)
    const packageRelative = relative(packageRoot, entry)
    if (packageRelative.startsWith('..') || isAbsolute(packageRelative) || !existsSync(entry)) return undefined
    return entry
  } catch {
    return undefined
  }
}

/** Match the runtime selection performed by npm's Windows command shim. */
function windowsNodeExecutable(
  binDirectory: string,
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  const adjacent = join(binDirectory, 'node.exe')
  if (existsSync(adjacent)) return adjacent
  for (const directory of windowsPathDirectories(env)) {
    const candidate = join(directory, 'node.exe')
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

/**
 * npm exposes global binaries as .cmd shims on Windows. Node cannot execute
 * those shims without a shell, while spawn(..., { shell: true }) leaves args
 * unescaped (DEP0190). Resolve npm's real JS entry and run it in Electron's
 * Node mode instead.
 */
function resolveWindowsDsh(
  executable: string,
  configuredArgs: readonly string[],
  host: LaunchHost,
): LaunchCommand | undefined {
  if (executable !== '' && executableBasename(executable).toLowerCase() !== 'dsh.cmd') return undefined

  const explicitPath = executable !== '' && /[\\/]/.test(executable)
    ? explicitExecutablePath(executable, host.cwd)
    : undefined
  const directories = explicitPath === undefined
    ? windowsPathDirectories(host.env)
    : [dirname(explicitPath)]
  for (const directory of directories) {
    if (!existsSync(join(directory, 'dsh.cmd'))) continue
    const entry = installedDshEntry(directory)
    if (entry === undefined) continue
    const node = windowsNodeExecutable(directory, host.env)
    if (node === undefined) continue
    return {
      command: node,
      args: [entry, ...configuredArgs],
      sourceCheckout: false,
    }
  }
  return undefined
}

function resolveTsxImport(sourceRoot: string): string {
  try {
    const require = createRequire(join(sourceRoot, 'package.json'))
    return pathToFileURL(require.resolve('tsx/esm')).href
  } catch {
    // The CLI will emit the actionable missing-dependency error. Keeping the
    // package specifier also makes launch resolution usable before install.
    return 'tsx/esm'
  }
}

/** Extract the URL printed by the official web-app Cordis plugin. */
export function parseDshWebUrl(line: string): string | undefined {
  const match = /(?:^|\s)dsh web:\s+(http:\/\/127\.0\.0\.1:\d+)(?:\s|$)/.exec(line)
  return match?.[1]
}

/**
 * Find a deepseek-harness source root above the extension directory.
 * The packaged extension has no such root and falls back to the installed dsh command.
 */
export function findSourceRoot(extensionPath: string): string | undefined {
  let cursor = resolve(extensionPath)
  for (let depth = 0; depth < 6; depth += 1) {
    const manifestPath = join(cursor, 'package.json')
    const cliPath = join(cursor, 'apps', 'cli', 'src', 'bin.ts')
    if (existsSync(manifestPath) && existsSync(cliPath)) {
      try {
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { name?: unknown }
        if (manifest.name === SOURCE_ROOT_PACKAGE) return cursor
      } catch {
        // A malformed unrelated package.json is not a source checkout.
      }
    }
    const parent = dirname(cursor)
    if (parent === cursor) return undefined
    cursor = parent
  }
  return undefined
}

/** Resolve an explicit executable, a source-checkout launch, or dsh from PATH. */
export function resolveLaunch(
  extensionPath: string,
  executable: string,
  configuredArgs: readonly string[],
  overrides: Partial<LaunchHost> = {},
): LaunchCommand {
  const configuredExecutable = executable.trim()
  const host: LaunchHost = {
    platform: overrides.platform ?? process.platform,
    env: overrides.env ?? process.env,
    cwd: overrides.cwd ?? process.cwd(),
  }

  if (configuredExecutable !== '') {
    const windowsLaunch = host.platform === 'win32'
      ? resolveWindowsDsh(configuredExecutable, configuredArgs, host)
      : undefined
    return windowsLaunch ?? {
      command: configuredExecutable,
      args: [...configuredArgs],
      sourceCheckout: false,
    }
  }

  const sourceRoot = findSourceRoot(extensionPath)
  if (sourceRoot !== undefined) {
    return {
      // Extension Hosts run under Electron. ELECTRON_RUN_AS_NODE (set by the
      // runtime owner) turns this exact executable into its bundled Node, so a
      // macOS GUI launch does not depend on the shell's PATH.
      command: process.execPath,
      args: [
        '--import',
        resolveTsxImport(sourceRoot),
        join(sourceRoot, 'apps', 'cli', 'src', 'bin.ts'),
        ...configuredArgs,
      ],
      sourceCheckout: true,
      env: {
        ELECTRON_RUN_AS_NODE: '1',
        TSX_TSCONFIG_PATH: join(sourceRoot, 'tsconfig.json'),
      },
    }
  }

  if (host.platform === 'win32') {
    const windowsLaunch = resolveWindowsDsh('', configuredArgs, host)
    if (windowsLaunch !== undefined) return windowsLaunch
  }

  return {
    command: host.platform === 'win32' ? 'dsh.cmd' : 'dsh',
    args: [...configuredArgs],
    sourceCheckout: false,
  }
}
