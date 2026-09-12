import { afterEach, describe, expect, it, vi } from 'vitest'
import { DshConnectionError } from '../src/dsh-connection.js'
import { DshStreamError } from '../src/dsh-streams.js'
import { canRetryConnection, reconnectAttempts } from '../src/dsh-reconnect.js'

afterEach(() => vi.useRealTimers())

describe('connection retry policy', () => {
  it('only retries transport loss and server unavailability', () => {
    for (const error of [new DshStreamError('closed', true), new DshConnectionError('transport-error', 'offline'),
      new DshConnectionError('http-error', 'unavailable', 503)]) expect(canRetryConnection(error)).toBe(true)
    for (const error of [new DshStreamError('invalid frame'), new Error('unknown'),
      new DshConnectionError('authentication-required', 'refused', 401), new DshConnectionError('invalid-response', 'invalid'),
      new DshConnectionError('http-error', 'bad request', 400)]) expect(canRetryConnection(error)).toBe(false)
  })

  it('backs off, stops after three attempts, and cancels pending delays', async () => {
    vi.useFakeTimers()
    const attempt = vi.fn().mockRejectedValue(new DshStreamError('offline', true))
    const task = reconnectAttempts(attempt, new AbortController().signal, true)
    const failed = expect(task).rejects.toThrow('offline')
    await vi.advanceTimersByTimeAsync(499)
    expect(attempt).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(attempt).toHaveBeenCalledExactlyOnceWith(1)
    await vi.advanceTimersByTimeAsync(4500)
    await failed
    expect(attempt.mock.calls).toEqual([[1], [2], [3]])
    const abort = new AbortController()
    const cancelled = expect(reconnectAttempts(attempt, abort.signal, true)).rejects.toThrow()
    abort.abort()
    await cancelled
    await vi.advanceTimersByTimeAsync(10000)
    expect(attempt).toHaveBeenCalledTimes(3)
    expect(vi.getTimerCount()).toBe(0)
  })
})
