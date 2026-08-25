export type DebugSessionPhase = 'starting' | 'running' | 'stopped' | 'terminated'
export type DebugThreadPhase = 'running' | 'stopped'

export interface DebugSessionState {
  readonly phase: DebugSessionPhase
  readonly stopEpoch: number
  readonly threads: Readonly<Record<string, DebugThreadPhase>>
  readonly currentThreadId?: number
  readonly stopReason?: string
}

export function initialDebugSessionState(): DebugSessionState {
  return { phase: 'starting', stopEpoch: 0, threads: {} }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined
}

function number(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined
}

function string(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

function phaseForThreads(threads: Readonly<Record<string, DebugThreadPhase>>): DebugSessionPhase {
  return Object.values(threads).includes('stopped') ? 'stopped' : 'running'
}

function markRunning(
  state: DebugSessionState,
  threadId: number | undefined,
  allThreads: boolean,
): DebugSessionState {
  const threads: Record<string, DebugThreadPhase> = { ...state.threads }
  if (allThreads) {
    for (const id of Object.keys(threads)) threads[id] = 'running'
  } else if (threadId !== undefined) {
    threads[String(threadId)] = 'running'
  }
  const phase = phaseForThreads(threads)
  const currentThreadId = phase === 'stopped'
    ? (state.currentThreadId !== undefined && threads[String(state.currentThreadId)] === 'stopped'
        ? state.currentThreadId
        : Object.entries(threads).find(([, threadPhase]) => threadPhase === 'stopped')?.[0])
    : undefined
  const normalizedThreadId = typeof currentThreadId === 'string' ? Number(currentThreadId) : currentThreadId
  return {
    phase,
    stopEpoch: state.stopEpoch,
    threads,
    ...(phase === 'stopped' ? {
      ...(normalizedThreadId === undefined ? {} : { currentThreadId: normalizedThreadId }),
      ...(normalizedThreadId !== state.currentThreadId || state.stopReason === undefined ? {} : { stopReason: state.stopReason }),
    } : {}),
  }
}

/** Reduce the small DAP subset needed to keep agent-owned sessions in sync. */
export function reduceDebugAdapterMessage(state: DebugSessionState, message: unknown): DebugSessionState {
  const envelope = record(message)
  if (envelope === undefined) return state

  if (envelope.type === 'response') {
    const command = string(envelope.command)
    if (envelope.success === true
      && (command === 'continue' || command === 'next' || command === 'stepIn' || command === 'stepOut' || command === 'restart')) {
      const body = record(envelope.body)
      return markRunning(state, state.currentThreadId, command === 'restart' || body?.allThreadsContinued === true)
    }
    return state
  }

  if (envelope.type === 'request') return state

  if (envelope.type !== 'event') return state
  const event = string(envelope.event)
  const body = record(envelope.body)

  if (event === 'initialized' || event === 'process' || event === 'thread') {
    if (state.phase !== 'starting') return state
    return { ...state, phase: 'running' }
  }

  if (event === 'stopped') {
    const threadId = number(body?.threadId)
    const stopReason = string(body?.reason)
    const allThreadsStopped = body?.allThreadsStopped === true
    const threads: Record<string, DebugThreadPhase> = { ...state.threads }
    if (allThreadsStopped) {
      for (const id of Object.keys(threads)) threads[id] = 'stopped'
    }
    if (threadId !== undefined) threads[String(threadId)] = 'stopped'
    return {
      phase: 'stopped',
      stopEpoch: state.stopEpoch + 1,
      threads,
      ...(threadId === undefined ? {} : { currentThreadId: threadId }),
      ...(stopReason === undefined ? {} : { stopReason }),
    }
  }

  if (event === 'continued') {
    return markRunning(state, number(body?.threadId), body?.allThreadsContinued === true)
  }

  if (event === 'terminated' || event === 'exited') {
    return { phase: 'terminated', stopEpoch: state.stopEpoch, threads: {} }
  }

  return state
}
