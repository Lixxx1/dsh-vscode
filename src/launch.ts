import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export interface LaunchCommand {
  command: string
  args: string[]
  sourceCheckout: boolean
  env?: Readonly<Record<string, string>>
}

const SOURCE_ROOT_PACKAGE = '@deepseek-ai/dsh-root'

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
): LaunchCommand {
  if (executable.trim() !== '') {
    return { command: executable, args: [...configuredArgs], sourceCheckout: false }
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

  return {
    command: process.platform === 'win32' ? 'dsh.cmd' : 'dsh',
    args: [...configuredArgs],
    sourceCheckout: false,
  }
}
