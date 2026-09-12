import { DshConnectionError } from './dsh-connection.js'
import { DshStreamError } from './dsh-streams.js'

/** Only transport loss is retried automatically, never protocol or auth failures. */
export function canRetryConnection(error: unknown): boolean {
  return (error instanceof DshStreamError && error.retryable)
    || (error instanceof DshConnectionError && (error.code === 'transport-error'
      || (error.code === 'http-error' && (error.status ?? 0) >= 500)))
}

export async function reconnectAttempts(
  attempt: (index: number) => Promise<void>, signal: AbortSignal, automatic: boolean,
): Promise<void> {
  const delays = automatic ? [500, 1500, 3000] : [0]
  for (let index = 0; index < delays.length; index++) {
    await pause(delays[index]!, signal)
    signal.throwIfAborted()
    try {
      await attempt(index + 1)
      signal.throwIfAborted()
      return
    } catch (error) {
      signal.throwIfAborted()
      if (!canRetryConnection(error) || index === delays.length - 1) throw error
    }
  }
}

function pause(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const abort = (): void => { clearTimeout(timer); reject(signal.reason) }
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve() }, ms)
    signal.addEventListener('abort', abort, { once: true })
  })
}
