import { spawn, type ChildProcess } from 'node:child_process'
import { win32 as windowsPath } from 'node:path'

type KillableProcess = Pick<ChildProcess, 'pid' | 'exitCode' | 'signalCode' | 'kill'>

interface ProcessTreeHost {
  platform: NodeJS.Platform
  spawnProcess: typeof spawn
  env: Readonly<Record<string, string | undefined>>
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

/**
 * Stop a child and, on Windows, every descendant created by cmd.exe shims.
 * Node's child.kill() only targets the wrapper process there, which can leave
 * the actual DSH or package-manager process running in the background.
 */
export function terminateProcessTree(
  child: KillableProcess,
  signal: NodeJS.Signals = 'SIGTERM',
  overrides: Partial<ProcessTreeHost> = {},
): boolean {
  if (child.exitCode !== null || child.signalCode !== null) return false

  const platform = overrides.platform ?? process.platform
  if (platform !== 'win32' || child.pid === undefined) return child.kill(signal)

  const spawnProcess = overrides.spawnProcess ?? spawn
  const env = overrides.env ?? process.env
  let fellBack = false
  const fallback = (): void => {
    if (fellBack || child.exitCode !== null || child.signalCode !== null) return
    fellBack = true
    child.kill('SIGKILL')
  }

  const systemRoot = environmentValue(env, 'SystemRoot') || environmentValue(env, 'windir')
  if (systemRoot === undefined) {
    fallback()
    return fellBack
  }
  const taskkillExecutable = windowsPath.join(systemRoot, 'System32', 'taskkill.exe')

  try {
    const taskkill = spawnProcess(
      taskkillExecutable,
      ['/PID', String(child.pid), '/T', '/F'],
      { stdio: 'ignore', windowsHide: true },
    )
    taskkill.once('error', fallback)
    taskkill.once('close', code => {
      if (code !== 0) fallback()
    })
    return true
  } catch {
    fallback()
    return fellBack
  }
}
