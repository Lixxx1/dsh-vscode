import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export interface LaunchCommand {
  command: string
  args: string[]
  sourceCheckout: boolean
  env?: Readonly<Record<string, string>>
  windowsVerbatimArguments?: boolean
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

function environmentValue(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
): string | undefined {
  for (const [key, value] of Object.entries(env)) {
    if (key.toLowerCase() === name.toLowerCase()) return value
  }
  return undefined
}

function windowsPathExtensions(env: Readonly<Record<string, string | undefined>>): string[] {
  const configured = environmentValue(env, 'PATHEXT')
    ?.split(';')
    .map(value => value.trim())
    .filter(value => value !== '')
  return configured !== undefined && configured.length > 0 ? configured : ['.COM', '.EXE', '.BAT', '.CMD']
}

function executableBasename(executable: string): string {
  return executable.split(/[\\/]/).at(-1) ?? executable
}

/** Node's spawn cannot execute .cmd/.bat shims directly on modern Windows. */
function isWindowsShellScript(executable: string): boolean {
  const basename = executableBasename(executable).toLowerCase()
  return basename.endsWith('.cmd') || basename.endsWith('.bat')
}

/** CreateProcess can launch these formats without consulting cmd.exe. */
function isWindowsNativeExecutable(executable: string): boolean {
  const extension = extname(executableBasename(executable)).toLowerCase()
  return extension === '.exe' || extension === '.com'
}

function comSpec(env: Readonly<Record<string, string | undefined>>): string {
  return environmentValue(env, 'ComSpec') || 'cmd.exe'
}

const WINDOWS_CMD_META = /([()\][%!^"`<>&|;, *?\t])/g

function safeWindowsShellValue(value: string): string {
  if (/[\0\r\n]/.test(value)) {
    throw new Error('Windows shell commands and arguments cannot contain NUL or newline characters.')
  }
  return value
}

function escapeWindowsShellCommand(value: string): string {
  return safeWindowsShellValue(value).replace(WINDOWS_CMD_META, '^$1')
}

function escapeWindowsShellArgument(value: string, doubleEscapeMeta: boolean): string {
  let escaped = safeWindowsShellValue(value)
  // Match CommandLineToArgvW quoting before cmd.exe consumes its own syntax.
  escaped = escaped.replace(/(?=(\\+?)?)\1"/g, '$1$1\\"')
  escaped = escaped.replace(/(?=(\\+?)?)\1$/g, '$1$1')
  escaped = `"${escaped}"`.replace(WINDOWS_CMD_META, '^$1')
  return doubleEscapeMeta ? escaped.replace(WINDOWS_CMD_META, '^$1') : escaped
}

/**
 * Run a Windows .cmd/.bat shim through cmd.exe with every token pre-escaped.
 * windowsVerbatimArguments prevents Node from quoting the already encoded
 * command a second time. Used only when a shell-free executable or npm JS
 * entry cannot be resolved.
 */
function windowsShellFallback(
  command: string,
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): LaunchCommand {
  const doubleEscapeMeta = /node_modules[\\/]\.bin[\\/][^\\/]+\.cmd$/i.test(command)
  const shellCommand = [
    escapeWindowsShellCommand(command),
    ...args.map(value => escapeWindowsShellArgument(value, doubleEscapeMeta)),
  ].join(' ')
  return {
    command: comSpec(env),
    args: ['/d', '/s', '/c', `"${shellCommand}"`],
    sourceCheckout: false,
    windowsVerbatimArguments: true,
  }
}

function explicitExecutablePath(executable: string, cwd: string): string {
  if (isAbsolute(executable)) return executable
  return resolve(cwd, ...executable.split(/[\\/]+/))
}

function existingWindowsFile(directory: string, fileName: string): string | undefined {
  try {
    const entry = readdirSync(directory).find(value => value.toLowerCase() === fileName.toLowerCase())
    if (entry === undefined) return undefined
    const candidate = join(directory, entry)
    return statSync(candidate).isFile() ? candidate : undefined
  } catch {
    return undefined
  }
}

/** Resolve exactly the command Windows would pick from PATH and PATHEXT. */
function resolveWindowsPathCommand(executable: string, host: LaunchHost): string | undefined {
  const hasDirectory = /[\\/]/.test(executable)
  const explicitPath = hasDirectory ? explicitExecutablePath(executable, host.cwd) : undefined
  const searchDirectories = [
    ...(environmentValue(host.env, 'NoDefaultCurrentDirectoryInExePath') === undefined ? [host.cwd] : []),
    ...windowsPathDirectories(host.env),
  ]
  const directories = explicitPath === undefined
    ? searchDirectories.filter((value, index, values) => (
        values.findIndex(candidate => candidate.toLowerCase() === value.toLowerCase()) === index
      ))
    : [dirname(explicitPath)]
  const name = executableBasename(explicitPath ?? executable)
  const names = extname(name) === ''
    ? windowsPathExtensions(host.env).map(extension => `${name}${extension.startsWith('.') ? extension : `.${extension}`}`)
    : [name]

  for (const directory of directories) {
    for (const candidate of names) {
      const match = existingWindowsFile(directory, candidate)
      if (match !== undefined) return match
    }
  }
  return undefined
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
  const basename = executableBasename(executable).toLowerCase()
  if (executable !== '' && basename !== 'dsh' && basename !== 'dsh.cmd') return undefined

  const requested = executable === '' ? 'dsh' : executable
  const match = resolveWindowsPathCommand(requested, host)
  if (match !== undefined) {
    if (isWindowsNativeExecutable(match)) {
      return { command: match, args: [...configuredArgs], sourceCheckout: false }
    }
    if (match.toLowerCase().endsWith('.cmd')) {
      const directory = dirname(match)
      const entry = installedDshEntry(directory)
      const node = entry === undefined ? undefined : windowsNodeExecutable(directory, host.env)
      if (entry !== undefined && node !== undefined) {
        return {
          command: node,
          args: [entry, ...configuredArgs],
          sourceCheckout: false,
        }
      }
    }
    return windowsShellFallback(match, configuredArgs, host.env)
  }

  const fallback = /[\\/]/.test(requested)
    ? explicitExecutablePath(requested, host.cwd)
    : requested
  return windowsShellFallback(fallback, configuredArgs, host.env)
}

function supportsNoOpen(version: string): boolean {
  // Tolerate a 'v' prefix and semver build metadata (e.g. 'v0.1.0-rc.8+abc').
  const match = /(?:^|\s)v?(\d+)\.(\d+)\.(\d+)(?:-rc\.(\d+))?(?=[+\s]|$)/.exec(version)
  if (match === null) return false
  const major = Number(match[1])
  const minor = Number(match[2])
  const patch = Number(match[3])
  const rc = match[4] === undefined ? undefined : Number(match[4])
  if (major !== 0) return major > 0
  if (minor !== 1) return minor > 1
  if (patch !== 0) return patch > 0
  return rc === undefined || rc >= 8
}

/** Keep the extension-owned Web Host from opening a second, unused UI on rc.8+. */
export function webArgsForDshVersion(args: readonly string[], version: string | undefined): string[] {
  const webProfile = args[0] === 'web' || (args[0] === '--profile' && args[1] === 'web')
  if (!webProfile || args.includes('--no-open') || version === undefined || !supportsNoOpen(version)) return [...args]
  return [...args, '--no-open']
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
    if (host.platform === 'win32') {
      const windowsLaunch = resolveWindowsDsh(configuredExecutable, configuredArgs, host)
      if (windowsLaunch !== undefined) return windowsLaunch
      if (isWindowsShellScript(configuredExecutable)) {
        const command = /[\\/]/.test(configuredExecutable)
          ? explicitExecutablePath(configuredExecutable, host.cwd)
          : configuredExecutable
        return windowsShellFallback(command, configuredArgs, host.env)
      }
    }
    return {
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
    command: 'dsh',
    args: [...configuredArgs],
    sourceCheckout: false,
  }
}
