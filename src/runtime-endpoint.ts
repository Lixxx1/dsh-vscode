import { randomUUID } from 'node:crypto'

export const DEFAULT_DSH_SERVER_URL = 'http://127.0.0.1:3080'
export const DEFAULT_DSH_WEB_ARGS = ['web', '--host', '127.0.0.1', '--port', '0'] as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** Verify that a local endpoint speaks the official DSH RPC protocol. */
export async function probeDshServer(baseUrl: URL, timeoutMs = 750): Promise<boolean> {
  const rpcId = randomUUID()
  try {
    const response = await fetch(new URL('/api/session.list', baseUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId, method: 'session.list', payload: {} }),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) return false
    const envelope: unknown = await response.json()
    if (!isRecord(envelope) || envelope.type !== 'server-response' || envelope.rpcId !== rpcId) return false
    const result = envelope.result
    if (!isRecord(result) || result.ok !== true || !isRecord(result.value)) return false
    return Array.isArray(result.value.items)
  } catch {
    return false
  }
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
