import { describe, expect, it } from 'vitest'
import { initialDebugSessionState, reduceDebugAdapterMessage } from '../src/debug-state.ts'

describe('debug session state', () => {
  it('tracks a normal stop, continue, and second stop without reusing the epoch', () => {
    const initial = initialDebugSessionState()
    const stopped = reduceDebugAdapterMessage(initial, {
      type: 'event',
      event: 'stopped',
      body: { reason: 'breakpoint', threadId: 7, allThreadsStopped: true },
    })
    expect(stopped).toMatchObject({
      phase: 'stopped',
      stopEpoch: 1,
      currentThreadId: 7,
      stopReason: 'breakpoint',
      threads: { 7: 'stopped' },
    })

    const running = reduceDebugAdapterMessage(stopped, {
      type: 'event',
      event: 'continued',
      body: { threadId: 7, allThreadsContinued: true },
    })
    expect(running).toEqual({ phase: 'running', stopEpoch: 1, threads: { 7: 'running' } })

    const stepped = reduceDebugAdapterMessage(running, {
      type: 'event',
      event: 'stopped',
      body: { reason: 'step', threadId: 7 },
    })
    expect(stepped).toMatchObject({ phase: 'stopped', stopEpoch: 2, stopReason: 'step' })
  })

  it('keeps a session stopped while another thread continues', () => {
    const oneStopped = reduceDebugAdapterMessage(initialDebugSessionState(), {
      type: 'event',
      event: 'stopped',
      body: { reason: 'pause', threadId: 1 },
    })
    const twoStopped = reduceDebugAdapterMessage(oneStopped, {
      type: 'event',
      event: 'stopped',
      body: { reason: 'pause', threadId: 2 },
    })
    const oneContinued = reduceDebugAdapterMessage(twoStopped, {
      type: 'event',
      event: 'continued',
      body: { threadId: 1, allThreadsContinued: false },
    })

    expect(oneContinued.phase).toBe('stopped')
    expect(oneContinued.threads).toEqual({ 1: 'running', 2: 'stopped' })
  })

  it('marks execution controls running even when an adapter omits continued events', () => {
    const stopped = reduceDebugAdapterMessage(initialDebugSessionState(), {
      type: 'event', event: 'stopped', body: { reason: 'breakpoint', threadId: 4 },
    })
    const requested = reduceDebugAdapterMessage(stopped, {
      type: 'request', command: 'next', arguments: { threadId: 4 },
    })

    expect(requested).toEqual({ phase: 'running', stopEpoch: 1, threads: { 4: 'running' } })
  })

  it('treats exited and terminated as terminal states', () => {
    const running = reduceDebugAdapterMessage(initialDebugSessionState(), { type: 'event', event: 'process' })
    expect(reduceDebugAdapterMessage(running, { type: 'event', event: 'exited' }))
      .toEqual({ phase: 'terminated', stopEpoch: 0, threads: {} })
  })
})
