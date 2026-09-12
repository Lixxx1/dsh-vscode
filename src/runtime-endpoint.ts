import { DshConnection, DshConnectionError } from './dsh-connection.js'

export const DEFAULT_DSH_SERVER_URL = 'http://127.0.0.1:3080'
export const DEFAULT_DSH_WEB_ARGS = ['web', '--host', '127.0.0.1', '--port', '0'] as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

export type DshServerProbe =
  | { kind: 'ready' }
  | { kind: 'authentication-required' }
  | { kind: 'unsupported' }
  | { kind: 'unavailable' }
  | { kind: 'invalid-response' }

/** Probe the new read-only contract; a 401 must not be mistaken for a stopped server. */
export async function probeDshServer(connection: DshConnection, timeoutMs = 750): Promise<DshServerProbe> {
  try {
    const value = await connection.call<unknown>('session/list', { _request: {} }, timeoutMs)
    return { kind: isRecord(value) && Array.isArray(value.items) ? 'ready' : 'invalid-response' }
  } catch (error) {
    if (error instanceof DshConnectionError) {
      if (error.code === 'authentication-required') return { kind: 'authentication-required' }
      if (error.status === 404 || error.code === 'gateway/not-found') return { kind: 'unsupported' }
      if (error.code === 'invalid-response') return { kind: 'invalid-response' }
    }
    return { kind: 'unavailable' }
  }
}

export const DSH_UPGRADE_MESSAGE = 'This sidebar requires DeepSeek Harness 0.1.2-rc.1 or a compatible newer release. Update DSH, then reconnect.'

/** Unknown/source versions are checked against the actual Remote contract at startup. */
export function assertSupportedDshVersion(version: string | undefined): void {
  const match = /(?:^|\s|v)(\d+)\.(\d+)\.(\d+)(?:-([\w.-]+))?(?:\+[\w.-]+)?(?:\s|$)/.exec(version ?? '')
  if (match === null) return
  const major = Number(match[1])
  const minor = Number(match[2])
  const patch = Number(match[3])
  if (major > 0 || minor > 1 || (minor === 1 && patch > 2)) return
  if (minor === 1 && patch === 2
    && (match[4] === undefined || /^rc\.[1-9]\d*$/.test(match[4]))) return
  throw new Error(DSH_UPGRADE_MESSAGE)
}

/** Explicit launch settings take precedence over automatic endpoint reuse. */
export function shouldProbeExistingDsh(
  enabled: boolean,
  executable: string,
  hasCustomArguments: boolean,
): boolean {
  return enabled
    && executable.trim() === ''
    && !hasCustomArguments
}
