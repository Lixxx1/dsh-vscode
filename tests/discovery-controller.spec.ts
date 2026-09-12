import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DshFrame, SessionModels, SkillDescriptor } from '../src/dsh-client.js'
import { withIdeContext } from '../src/ide-context.js'
import { DshStreamError } from '../src/dsh-streams.js'
import { ExistingRuntimeConnectionError } from '../src/runtime-target.js'

const mocks = vi.hoisted(() => ({ client: undefined as any }))
vi.mock('../src/dsh-client.js', () => ({ DshClient: class {
  constructor(_connection: unknown, requestSessions: string[] = []) {
    mocks.client.handledSessionIds = requestSessions
    return mocks.client
  }
} }))
vi.mock('vscode', () => ({
  EventEmitter: class {
    listeners = new Set<(value: unknown) => void>()
    event = (listener: (value: unknown) => void) => { this.listeners.add(listener); return { dispose: () => this.listeners.delete(listener) } }
    fire(value: unknown) { for (const listener of this.listeners) listener(value) }
    dispose() { this.listeners.clear() }
  },
  Uri: { file: (fsPath: string) => ({ fsPath, scheme: 'file' }) },
}))
import { DshChatController } from '../src/extension.js'

const controllers: DshChatController[] = []
afterEach(() => { controllers.splice(0).forEach(controller => controller.dispose()); vi.useRealTimers() })
const models = (id = 'model'): SessionModels => ({ current: { provider: 'p', model: id }, routable: true,
  groups: [{ id: 'p', name: 'Provider', models: [{ id, name: id }] }], failures: [] })

function testClient() {
  const listeners = new Set<(frame: DshFrame) => void>()
  const errors = new Set<(error: Error) => void>()
  const projections = { agentPreset: 'standard', plan: { active: false, pending: false } }
  const client = {
    onFrame: vi.fn((callback: (frame: DshFrame) => void) => { listeners.add(callback); return () => listeners.delete(callback) }),
    onError: vi.fn((callback: (error: Error) => void) => { errors.add(callback); return () => errors.delete(callback) }),
    startStreams: vi.fn(async () => {}), dispose: vi.fn(), handledSessionIds: [] as string[], respond: vi.fn(async () => ({ accepted: true })),
    listWorkspaces: vi.fn(async () => ({ archivedSessionIds: [] })),
    listSessions: vi.fn(async () => ({ items: ['a', 'b'].map(sessionId => ({ sessionId, cwd: '/workspace', updatedAt: 1,
      blank: true, running: false, agentPreset: 'standard', projections: { values: { ...projections } } })) })),
    openSession: vi.fn(async () => ({ events: [], hasMore: false, projections: { ...projections }, isCurrent: () => true, activate() {} })),
    models: vi.fn(async () => models()), currentModels: vi.fn(() => models()),
    listCommands: vi.fn(async () => [{ name: 'plan', description: 'Plan' }]),
    listSkills: vi.fn(async (): Promise<SkillDescriptor[]> => []),
    listAgentPresets: vi.fn(async () => ({ presets: [{ id: 'standard', trust: 'system', isDefault: true }, { id: 'minimal', trust: 'system', isDefault: false }] })),
    selectModel: vi.fn(async () => ({})), settings: vi.fn(), mutateSettings: vi.fn(), pluginInventory: vi.fn(),
    selectAgentPreset: vi.fn(), prompt: vi.fn(async () => ({})),
    updateQueue: vi.fn(async () => ({ accepted: true })),
    executeCommand: vi.fn(async () => ({ result: { kind: 'success' } })),
  }
  const emit = (payload: Record<string, unknown>, channel: 'host' | 'mux' = 'host', rpcId = '') => {
    for (const listener of listeners) listener({ channel, rpcId, payload })
  }
  const fail = (error: Error) => { for (const listener of [...errors]) listener(error) }
  return { client, emit, fail }
}

async function harness() {
  const { client, emit, fail } = testClient()
  mocks.client = client
  const output = { appendLine: vi.fn() }
  const runtime = { start: vi.fn(async () => {}), stop: vi.fn(async () => {}), connection: { reauthenticate: vi.fn(async () => {}) }, state: { kind: 'ready' } }
  const reviews = { clear: vi.fn(), rebuild: vi.fn(() => []), accept: () => false, dispose() {} }
  const controller = new DshChatController(runtime as any,
    output as any, {} as any, reviews as any,
    { get: () => [], update: async () => {} } as any, '/workspace')
  controllers.push(controller)
  await controller.start()
  await vi.waitFor(() => expect(controller.state.commands).toHaveLength(1))
  const next = () => { const next = testClient(); mocks.client = next.client; return next }
  return { client, controller, output, emit, fail, runtime, reviews, next }
}

describe('runtime selection', () => {
  it('blocks switching projects while another conversation is running', async () => {
    const h = await harness()
    h.emit({ type: 'host/session-status', sessionId: 'b', running: true })
    expect(h.controller.state.running).toBe(false)
    expect(h.controller.hasRunningTasks).toBe(true)
    await expect(h.controller.switchWorkspace('/another-project')).rejects.toThrow('running DeepSeek tasks')
    expect(h.controller.cwd).toBe('/workspace')
    expect(h.runtime.stop).not.toHaveBeenCalled()
    h.emit({ type: 'host/session-status', sessionId: 'b', running: false })
    expect(h.controller.hasRunningTasks).toBe(false)
    expect(() => h.controller.assertCanSelectRuntime()).not.toThrow()
  })

  it('protects sessions outside the visible project, including child agents', async () => {
    const h = await harness()
    h.emit({ type: 'host/session-added', sessionId: 'foreign', cwd: '/elsewhere', updatedAt: 1, blank: false, running: true })
    h.emit({ type: 'host/session-added', sessionId: 'child', origin: 'subagent', cwd: '/workspace', updatedAt: 1, blank: false, running: true })
    expect(h.controller.state.sessions.every(item => !['foreign', 'child'].includes(item.id))).toBe(true)
    expect(h.controller.hasRunningTasks).toBe(true)
    await expect(h.controller.selectRuntime({ kind: 'managed' })).rejects.toThrow('running DeepSeek tasks')
    h.emit({ type: 'host/session-removed', sessionId: 'child' })
    expect(h.controller.hasRunningTasks).toBe(true)
    h.emit({ type: 'host/session-status', sessionId: 'foreign', running: false })
    expect(h.controller.hasRunningTasks).toBe(false)
  })

  it('includes already-running foreign sessions from the initial runtime snapshot', async () => {
    const h = await harness()
    const snapshot = await h.client.listSessions()
    h.client.listSessions.mockResolvedValue({ items: [...snapshot.items, { ...snapshot.items[0]!, sessionId: 'foreign', cwd: '/elsewhere', running: true }] })
    await h.controller.start()
    expect(h.controller.hasRunningTasks).toBe(true)
    expect(h.controller.state.sessions.every(item => item.id !== 'foreign')).toBe(true)
    h.controller.observeRuntime({ kind: 'stopped' })
    expect(h.controller.hasRunningTasks).toBe(false)
  })

  it.each([true, false])('keeps the latest running=%s event when session/list returns an older snapshot', async running => {
    const h = await harness()
    const snapshot = await h.client.listSessions()
    const pending = Promise.withResolvers<any>()
    h.client.listSessions.mockReturnValueOnce(pending.promise)
    const before = h.client.listSessions.mock.calls.length
    const loading = h.controller.start()
    await vi.waitFor(() => expect(h.client.listSessions.mock.calls.length).toBeGreaterThan(before))
    h.emit({ type: 'host/session-status', sessionId: 'b', running })
    pending.resolve({ items: snapshot.items.map(summary => summary.sessionId === 'b' ? { ...summary, running: !running } : summary) })
    await loading
    expect(h.controller.hasRunningTasks).toBe(running)
    h.emit({ type: 'host/session-status', sessionId: 'b', running: false })
    expect(h.controller.hasRunningTasks).toBe(false)
  })

  it('rechecks background tasks before saving restart-required settings, but allows live settings', async () => {
    const h = await harness()
    const restart = { ns: 'restart-setting', revision: 1, applies: 'restart' }
    const live = { ns: 'live-setting', revision: 1, applies: 'live' }
    h.client.settings.mockResolvedValue({ namespaces: [restart, live] })
    const [restartDraft, liveDraft] = (await h.controller.settings()).namespaces
    h.emit({ type: 'host/session-status', sessionId: 'b', running: true })
    expect(() => h.controller.mutateSettings(restartDraft!, [])).toThrow('all running DeepSeek tasks')
    expect(h.client.mutateSettings).not.toHaveBeenCalled()
    await h.controller.mutateSettings(liveDraft!, [])
    expect(h.client.mutateSettings).toHaveBeenCalledWith('live-setting', [], 1)
    h.emit({ type: 'host/session-status', sessionId: 'b', running: false })
    await h.controller.mutateSettings(restartDraft!, [])
    expect(h.client.mutateSettings).toHaveBeenCalledWith('restart-setting', [], 1)
  })

  it('disconnects the old client and passes the explicit target without publishing its credentials', async () => {
    const h = await harness()
    const next = h.next()
    const states: unknown[] = []
    h.controller.onDidChangeState(state => states.push(state))
    const target = { kind: 'external' as const, launchUrl: new URL('http://127.0.0.1:43127/?token=private-token') }
    await h.controller.selectRuntime(target)
    expect(h.runtime.stop).toHaveBeenCalledTimes(1)
    expect(h.client.dispose).toHaveBeenCalledTimes(1)
    expect(h.runtime.start).toHaveBeenLastCalledWith(expect.objectContaining({ fsPath: '/workspace' }), target)
    expect(next.client.startStreams).toHaveBeenCalledTimes(1)
    expect(h.controller.state.phase).toBe('ready')
    expect(JSON.stringify(states)).not.toContain('private-token')
    expect(h.reviews.clear).toHaveBeenCalledTimes(2)
  })

  it('does not switch during a background task or another connection attempt', async () => {
    const h = await harness()
    h.emit({ type: 'host/session-status', sessionId: 'b', running: true })
    await expect(h.controller.selectRuntime({ kind: 'managed' })).rejects.toThrow('running DeepSeek tasks')
    expect(h.runtime.stop).not.toHaveBeenCalled()
    h.controller.publish({ phase: 'loading' })
    await expect(h.controller.selectRuntime({ kind: 'managed' })).rejects.toThrow('connection attempt')
    expect(h.runtime.stop).not.toHaveBeenCalled()
  })

  it('renders the external connection choice from both startup rejection and runtime state', async () => {
    const h = await harness()
    h.runtime.start.mockRejectedValueOnce(new ExistingRuntimeConnectionError())
    await h.controller.restart()
    expect(h.controller.state).toMatchObject({ phase: 'error', setup: 'runtime-auth' })
    h.controller.observeRuntime({ kind: 'failed', reason: 'runtime-auth', message: 'Try another launch URL' })
    expect(h.controller.state).toMatchObject({ phase: 'error', setup: 'runtime-auth', statusText: 'Try another launch URL' })
  })

  it('does not complete a superseded switch after a newer restart', async () => {
    const h = await harness()
    let stop!: () => void
    const stopped = new Promise<void>(resolve => { stop = resolve })
    h.runtime.stop.mockReturnValue(stopped)
    const switching = h.controller.selectRuntime({ kind: 'external', launchUrl: new URL('http://127.0.0.1:43127/?token=old') })
    const restart = h.controller.restart({ kind: 'managed' })
    h.next()
    stop()
    await Promise.all([switching, restart])
    expect(h.runtime.start).toHaveBeenCalledTimes(2)
    expect(h.runtime.start).toHaveBeenLastCalledWith(expect.anything(), { kind: 'managed' })
  })

  it('does not connect to a selected runtime after disposal', async () => {
    const h = await harness()
    let stop!: () => void
    h.runtime.stop.mockReturnValue(new Promise<void>(resolve => { stop = resolve }))
    const switching = h.controller.selectRuntime({ kind: 'managed' })
    h.controller.dispose()
    stop(); await switching
    expect(h.runtime.start).toHaveBeenCalledTimes(1)
    await expect(h.controller.selectRuntime({ kind: 'managed' })).rejects.toThrow('sidebar has closed')
    await h.controller.restart()
    await h.controller.start()
    expect(h.runtime.stop).toHaveBeenCalledTimes(1)
    expect(h.runtime.start).toHaveBeenCalledTimes(1)
  })
})

describe('sidebar reconnect', () => {
  it('restores the selected conversation and background request scope without restarting or resending', async () => {
    const h = await harness()
    h.client.handledSessionIds.push('a')
    await h.controller.selectSession('b')
    h.emit({ type: 'session/event', sessionId: 'b', event: { type: 'user/message', seq: 1, time: 30,
      data: { content: [{ type: 'text', text: 'Already submitted' }] } } }, 'mux')
    const messages = h.controller.state.messages
    const oldListener = h.client.onFrame.mock.calls[0]![0]
    const next = h.next()
    next.client.openSession.mockResolvedValue({ events: [{ event: { type: 'assistant/message', seq: 2, time: 50,
      data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'Completed while offline' }] }, stream: [] } } }],
      hasMore: false, projections: {}, isCurrent: () => true, activate() {} } as any)
    vi.useFakeTimers()
    h.fail(new DshStreamError('Connection lost', true))
    expect(h.controller.state).toMatchObject({ phase: 'loading', sessionId: 'b', messages, approval: null, question: null })
    await expect(h.controller.send('Do not send')).rejects.toThrow('not connected')
    const reconnect = h.controller.reconnect()
    expect(h.controller.reconnect()).toBe(reconnect)
    await vi.advanceTimersByTimeAsync(500)
    await reconnect
    expect(h.controller.state).toMatchObject({ phase: 'ready', sessionId: 'b' })
    expect(h.controller.state.messages[0]?.text).toBe('Completed while offline')
    expect(next.client.handledSessionIds).toEqual(['a', 'b'])
    expect(h.runtime.start).toHaveBeenCalledTimes(1)
    expect(h.runtime.stop).not.toHaveBeenCalled()
    expect(h.runtime.connection.reauthenticate).not.toHaveBeenCalled()
    expect(h.reviews.clear).toHaveBeenCalledTimes(1)
    expect(next.client.prompt).not.toHaveBeenCalled()
    expect(next.client.respond).not.toHaveBeenCalled()
    expect(next.client.executeCommand).not.toHaveBeenCalled()
    expect(next.client.updateQueue).not.toHaveBeenCalled()
    oldListener({ channel: 'host', rpcId: '', payload: { type: 'host/session-activity', sessionId: 'b', updatedAt: 999 } })
    expect(h.controller.state.sessions.find(s => s.id === 'b')?.updatedAt).not.toBe(999)
  })

  it('bounds retry attempts and keeps the transcript when reconnection fails', async () => {
    const h = await harness()
    const next = h.next()
    next.client.startStreams.mockRejectedValue(new DshStreamError('Still offline', true))
    vi.useFakeTimers()
    h.fail(new DshStreamError('Connection lost', true))
    const reconnect = h.controller.reconnect()
    await vi.advanceTimersByTimeAsync(5000)
    await reconnect
    expect(next.client.startStreams).toHaveBeenCalledTimes(3)
    expect(h.controller.state).toMatchObject({ phase: 'error', sessionId: 'a', canReconnect: true, setup: null })
    expect(h.controller.state.statusText).toContain('No tasks were resent')
    expect(h.runtime.stop).not.toHaveBeenCalled()
    expect(next.client.prompt).not.toHaveBeenCalled()
  })

  it('does not loop indefinitely when the stream repeatedly drops just after recovery', async () => {
    const h = await harness()
    let active = { fail: h.fail }
    vi.useFakeTimers()
    for (let index = 0; index < 4; index++) {
      const next = h.next()
      active.fail(new DshStreamError('Flapping', true))
      const reconnect = h.controller.reconnect()
      await vi.advanceTimersByTimeAsync(500)
      await reconnect
      expect(next.client.startStreams).toHaveBeenCalledTimes(index < 3 ? 1 : 0)
      active = next
    }
    expect(h.controller.state.phase).toBe('error')
    expect(h.controller.state.statusText).toContain('keeps dropping')
    expect(h.runtime.stop).not.toHaveBeenCalled()
  })

  it('retries a stream failure during snapshot restoration without replaying commands', async () => {
    const h = await harness()
    const next = h.next()
    next.client.listSessions.mockImplementationOnce(async () => {
      next.fail(new DshStreamError('Lost during restore', true))
      throw new Error('Read cancelled by disposal')
    })
    vi.useFakeTimers()
    h.fail(new DshStreamError('Connection lost', true))
    const reconnect = h.controller.reconnect()
    await vi.advanceTimersByTimeAsync(2000)
    await reconnect
    expect(h.controller.state.phase).toBe('ready')
    expect(next.client.startStreams).toHaveBeenCalledTimes(2)
    expect(next.client.executeCommand).not.toHaveBeenCalled()
    expect(next.client.prompt).not.toHaveBeenCalled()
  })

  it('requires manual retry for protocol errors and never creates a replacement conversation', async () => {
    const h = await harness()
    const next = h.next()
    next.client.listSessions.mockResolvedValue({ items: [] })
    vi.useFakeTimers()
    h.fail(new DshStreamError('Invalid frame'))
    await vi.advanceTimersByTimeAsync(5000)
    expect(next.client.startStreams).not.toHaveBeenCalled()
    const reconnect = h.controller.reconnect()
    await vi.advanceTimersByTimeAsync(0)
    await reconnect
    expect(h.runtime.connection.reauthenticate).toHaveBeenCalledTimes(1)
    expect(h.controller.state.phase).toBe('error')
    expect(h.controller.state.statusText).toContain('No conversation is available')
    expect(h.runtime.start).toHaveBeenCalledTimes(1)
  })

  it.each(['dispose', 'stop', 'restart'])('cancels a scheduled reconnect on %s', async action => {
    const h = await harness()
    const next = h.next()
    vi.useFakeTimers()
    h.fail(new DshStreamError('Connection lost', true))
    const reconnect = h.controller.reconnect()
    if (action === 'dispose') h.controller.dispose()
    if (action === 'stop') { h.runtime.state.kind = 'stopped'; h.controller.observeRuntime({ kind: 'stopped' }) }
    if (action === 'restart') await h.controller.restart()
    await vi.advanceTimersByTimeAsync(5000)
    await reconnect
    expect(next.client.startStreams).toHaveBeenCalledTimes(action === 'restart' ? 1 : 0)
    expect(h.runtime.stop).toHaveBeenCalledTimes(action === 'restart' ? 1 : 0)
  })

  it('ignores a late snapshot from a reconnect superseded by an explicit restart', async () => {
    const h = await harness()
    const old = h.next()
    const opening = Promise.withResolvers<any>()
    old.client.openSession.mockReturnValueOnce(opening.promise)
    vi.useFakeTimers()
    h.fail(new DshStreamError('Connection lost', true))
    const reconnect = h.controller.reconnect()
    await vi.advanceTimersByTimeAsync(500)
    const fresh = h.next()
    await h.controller.restart()
    opening.resolve({ events: [], hasMore: false, projections: { title: 'Stale' }, isCurrent: () => true, activate() {} })
    await reconnect
    expect(h.controller.state.phase).toBe('ready')
    expect(fresh.client.openSession).toHaveBeenCalledTimes(1)
    expect(h.controller.state.sessions.some(s => s.title === 'Stale')).toBe(false)
  })

  it('does not let an old approval response clear a redelivered request after reconnecting', async () => {
    const h = await harness()
    const pending = Promise.withResolvers<any>()
    h.client.respond.mockReturnValueOnce(pending.promise)
    const payload = { type: 'approval/requested', sessionId: 'a', approvalId: 'same-id', toolName: 'Write' }
    h.emit(payload, 'mux', 'same-id')
    const response = h.controller.answerApproval('same-id', 'same-id', 'allowed-once')
    const next = h.next()
    vi.useFakeTimers()
    h.fail(new DshStreamError('Connection lost', true))
    const reconnect = h.controller.reconnect()
    await vi.advanceTimersByTimeAsync(500)
    await reconnect
    next.emit(payload, 'mux', 'same-id')
    pending.resolve({ accepted: true }); await response
    expect(h.controller.state.approval?.rpcId).toBe('same-id')
    expect(next.client.respond).not.toHaveBeenCalled()
  })
})

describe('sidebar discovery notifications', () => {
  it('shows pending background requests without moving focus or clearing them just by visiting', async () => {
    const h = await harness()
    const calls = h.client.openSession.mock.calls.length
    h.emit({ type: 'host/session-attention', sessionId: 'b', approvals: 2, questions: 1 })
    expect(h.controller.state).toMatchObject({ sessionId: 'a', approval: null, question: null })
    expect(h.client.openSession).toHaveBeenCalledTimes(calls)
    expect(h.controller.state.sessions.find(s => s.id === 'b')).toMatchObject({ attention: { approvals: 2, questions: 1 } })
    await h.controller.selectSession('b')
    expect(h.controller.state.sessions.find(s => s.id === 'b')?.attention).toEqual({ approvals: 2, questions: 1 })
    h.emit({ type: 'host/session-attention', sessionId: 'b', approvals: 0, questions: 1 })
    expect(h.controller.state.sessions.find(s => s.id === 'b')?.attention).toEqual({ approvals: 0, questions: 1 })
    h.emit({ type: 'host/session-attention', sessionId: 'b', approvals: 0, questions: 0 })
    expect(h.controller.state.sessions.find(s => s.id === 'b')?.attention).toBeUndefined()
    h.emit({ type: 'host/session-attention', sessionId: 'unknown-workspace', approvals: 1, questions: 0 })
    expect(h.controller.state.sessions.some(s => s.id === 'unknown-workspace')).toBe(false)
    await h.controller.start()
    expect(h.controller.state.sessions.every(s => s.attention === undefined)).toBe(true)
  })

  it('updates titles, activity and running state without displaying subagents or changing the conversation', async () => {
    const h = await harness()
    const calls = h.client.openSession.mock.calls.length
    const added = { type: 'host/session-added', cwd: '/workspace', updatedAt: 20, running: false, blank: false,
      projections: { asOfSeq: 3, values: { title: 'Background work' } } }
    h.emit({ ...added, sessionId: 'child', origin: 'subagent' })
    h.emit({ ...added, sessionId: 'foreign', cwd: '/elsewhere' })
    h.emit({ ...added, sessionId: 'new' })
    expect(h.controller.state.sessions.map(s => s.id)).toEqual(['new', 'a'])
    expect(h.controller.state.sessions[0]?.title).toBe('Background work')
    h.emit({ type: 'host/session-activity', sessionId: 'b', updatedAt: 30 })
    h.emit({ type: 'host/session-activity', sessionId: 'b', updatedAt: 5 })
    h.emit({ type: 'session/projection', sessionId: 'new', key: 'title', value: 'Renamed' }, 'mux')
    expect(h.controller.state.sessions.map(s => s.id)).toEqual(['b', 'new', 'a'])
    expect(h.controller.state.sessions.find(s => s.id === 'b')).toMatchObject({ blank: false, updatedAt: 30 })
    expect(h.controller.state.sessions.find(s => s.id === 'new')).toMatchObject({ title: 'Renamed', updatedAt: 20 })
    h.emit({ type: 'host/session-status', sessionId: 'new', running: true })
    h.emit({ type: 'host/session-attention', sessionId: 'new', approvals: 1, questions: 0 })
    h.emit({ type: 'host/session-removed', sessionId: 'new' })
    expect(h.controller.state.sessions.find(s => s.id === 'new')).toMatchObject({ running: false, unread: true, title: 'Renamed' })
    expect(h.controller.state.sessions.find(s => s.id === 'new')?.attention).toBeUndefined()
    h.emit({ ...added, sessionId: 'new', projections: { values: { title: 'Resumed' } } })
    expect(h.controller.state.sessions.filter(s => s.id === 'new')).toHaveLength(1)
    expect(h.controller.state.sessions.find(s => s.id === 'new')?.title).toBe('Resumed')
    expect(h.controller.state.sessionId).toBe('a')
    expect(h.client.openSession).toHaveBeenCalledTimes(calls)
  })

  it('clears disposed interactive controls without erasing the current transcript', async () => {
    const h = await harness()
    h.emit({ type: 'session/event', sessionId: 'a', event: { type: 'user/message', seq: 1, time: 30,
      data: { content: [{ type: 'text', text: 'Work' }] } } }, 'mux')
    const messages = h.controller.state.messages
    h.emit({ type: 'host/session-status', sessionId: 'a', running: true })
    h.emit({ type: 'approval/requested', sessionId: 'a', approvalId: 'pending', toolName: 'Write' }, 'mux')
    h.emit({ type: 'session/queue', sessionId: 'a', items: [{ id: 'q', placement: 'queued', message: { content: [{ type: 'text', text: 'Follow up' }] } }] }, 'mux')
    h.emit({ type: 'host/session-removed', sessionId: 'a' })
    expect(h.controller.state).toMatchObject({ sessionId: 'a', running: false, messages, approval: null, question: null, queue: [], jobs: [] })
    expect(h.controller.state.sessions.some(s => s.id === 'a')).toBe(true)
  })

  it('does not let a delayed list refresh reopen the conversation after an explicit selection', async () => {
    const h = await harness()
    const pending = Promise.withResolvers<any>()
    const list = await h.client.listSessions()
    h.client.listSessions.mockReturnValueOnce(pending.promise)
    h.emit({ type: 'host/archived-sessions-changed', archivedSessionIds: [] })
    await h.controller.selectSession('b')
    const calls = h.client.openSession.mock.calls.length
    pending.resolve(list)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(h.controller.state.sessionId).toBe('b')
    expect(h.client.openSession).toHaveBeenCalledTimes(calls)
  })

  it('preserves captured IDE context on queue edits and rejects stale or attachment-only edits', async () => {
    const h = await harness()
    const original = withIdeContext('Original', { activeFile: { kind: 'file', path: 'app.ts' }, pinned: [], mentions: [] })
    h.emit({ type: 'session/queue', sessionId: 'a', items: [
      { id: 'text', placement: 'queued', message: { content: [{ type: 'text', text: original }] } },
      { id: 'image', placement: 'queued', message: { content: [{ type: 'image', name: 'test.png' }] } },
      { id: 'steering', placement: 'steering', message: { content: [{ type: 'text', text: 'Already steering' }] } },
    ] }, 'mux')
    await h.controller.updateQueue('a', 'text', 'edit', 'Edited')
    expect(h.client.updateQueue).toHaveBeenLastCalledWith('a', 'text', {
      kind: 'edit', content: [{ type: 'text', text: original.replace('Original', 'Edited') }],
    })
    await expect(h.controller.updateQueue('a', 'image', 'edit', 'Replace image')).rejects.toThrow('attachments')
    await expect(h.controller.updateQueue('a', 'missing', 'remove')).rejects.toThrow('no longer queued')
    await expect(h.controller.updateQueue('a', 'steering', 'edit', 'Too late')).rejects.toThrow('no longer queued')
    await expect(h.controller.updateQueue('a', 'text', 'steer')).rejects.toThrow('only while')
    expect(h.client.updateQueue).toHaveBeenCalledTimes(1)
    h.emit({ type: 'host/session-status', sessionId: 'a', running: true })
    await h.controller.updateQueue('a', 'text', 'steer')
    expect(h.client.updateQueue).toHaveBeenLastCalledWith('a', 'text', { kind: 'steer' })
    await h.controller.updateQueue('a', 'image', 'remove')
    expect(h.client.updateQueue).toHaveBeenLastCalledWith('a', 'image', { kind: 'remove' })
  })

  it('clears old interactive controls immediately and rejects old-session queue actions while loading or ready', async () => {
    const h = await harness()
    const items = [{ id: 'same-row', placement: 'queued', message: { content: [{ type: 'text', text: 'Original' }] } }]
    h.emit({ type: 'session/queue', sessionId: 'a', items }, 'mux')
    h.emit({ type: 'approval/requested', sessionId: 'a', approvalId: 'old', toolName: 'Write' }, 'mux')
    const loading = Promise.withResolvers<any>()
    h.client.openSession.mockReturnValueOnce(loading.promise)
    const switchSession = h.controller.selectSession('b')
    expect(h.controller.state).toMatchObject({ phase: 'loading', sessionId: 'b', queue: [], approval: null, question: null })
    await expect(h.controller.updateQueue('a', 'same-row', 'remove')).rejects.toThrow('conversation changed')
    await expect(h.controller.updateQueue('b', 'same-row', 'remove')).rejects.toThrow('conversation changed')
    loading.resolve({ events: [], hasMore: false, projections: {}, isCurrent: () => true, activate() {} })
    await switchSession
    h.emit({ type: 'session/queue', sessionId: 'b', items }, 'mux')
    await expect(h.controller.updateQueue('a', 'same-row', 'remove')).rejects.toThrow('conversation changed')
    expect(h.client.updateQueue).not.toHaveBeenCalled()
    await h.controller.updateQueue('b', 'same-row', 'remove')
    expect(h.client.updateQueue).toHaveBeenCalledExactlyOnceWith('b', 'same-row', { kind: 'remove' })
  })

  it('accepts the new command attachment capability without enabling attachments on other commands', async () => {
    const h = await harness()
    const image = { type: 'image' as const, mediaType: 'image/png' as const, data: 'YWJj' }
    h.client.listCommands.mockResolvedValue([{ name: 'plan', description: '', input: { hint: '', attachments: true } }] as any)
    await h.controller.send('/plan inspect', [image])
    expect(h.client.executeCommand).toHaveBeenCalledWith('a', '/plan inspect', [image])
    h.client.listCommands.mockResolvedValue([{ name: 'plan', description: '', input: { hint: '', attachments: false, images: true } }] as any)
    await expect(h.controller.send('/plan inspect', [image])).rejects.toThrow('does not accept image')
    expect(h.client.executeCommand).toHaveBeenCalledTimes(1)
  })

  it('publishes 0.1.5 live text without adding it to history and clears it at durable settlement', async () => {
    const h = await harness()
    const live = (update: unknown, sessionId = 'a') => h.emit({ type: 'session/assistant-stream', sessionId, update }, 'mux')
    live({ kind: 'start', attemptId: 'a:1', turn: 1, step: 1 })
    live({ kind: 'chunk', attemptId: 'a:1', chunk: { type: 'text-delta', text: 'Live text' } })
    expect(h.controller.state.messages).toMatchObject([{ text: 'Live text', streaming: true }])
    expect((h.controller as any).historyEntries).toEqual([])
    live({ kind: 'end', attemptId: 'a:1' }, 'b')
    expect(h.controller.state.messages[0]?.text).toBe('Live text')
    h.emit({ type: 'session/event', sessionId: 'a', event: {
      type: 'assistant/message', seq: 1, time: 10, surfaceOp: 'append',
      data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'Final text' }] }, stream: [] },
    } }, 'mux')
    expect(h.controller.state.messages).toEqual([{ id: 'assistant:1:1', role: 'assistant', text: 'Final text' }])
    expect((h.controller as any).historyEntries).toHaveLength(1)
  })

  it('refreshes commands and models, while permissions and Plan only follow projections', async () => {
    const h = await harness()
    h.client.listCommands.mockResolvedValue([])
    h.emit({ type: 'host/commands-changed' })
    await vi.waitFor(() => expect(h.controller.state.commands).toEqual([]))
    expect(h.controller.state.plan.available).toBe(false)
    h.client.models.mockResolvedValue(models('new-model'))
    h.emit({ type: 'host/models-changed' })
    await vi.waitFor(() => expect(h.controller.state.models[0]?.model).toBe('new-model'))
    h.emit({ type: 'session/projection', sessionId: 'a', key: 'permissions', value: {
      currentValue: 'read-only', options: [{ value: 'read-only' }, { value: 'workspace-write' }],
    } }, 'mux')
    expect(h.controller.state.permissions[0]?.selected).toBe(true)
    h.emit({ type: 'session/projection', sessionId: 'b', key: 'plan', value: { active: true, pending: false } }, 'mux')
    expect(h.controller.state.plan.active).toBe(false)
    h.emit({ type: 'session/projection', sessionId: 'a', key: 'plan', value: { active: true, pending: false } }, 'mux')
    expect(h.controller.state.plan).toEqual({ active: true, pending: false, available: false })
  })

  it('ignores delayed discovery results across A → B → A switches', async () => {
    const h = await harness()
    const old = Promise.withResolvers<Array<{ name: string; description: string }>>()
    h.client.listCommands.mockReturnValueOnce(old.promise)
    h.emit({ type: 'host/commands-changed' })
    await h.controller.selectSession('b')
    h.client.listCommands.mockResolvedValue([{ name: 'current', description: '' }])
    await h.controller.selectSession('a')
    await vi.waitFor(() => expect(h.controller.state.commands[0]?.name).toBe('current'))
    old.resolve([{ name: 'stale', description: '' }])
    await old.promise
    expect(h.controller.state.commands[0]?.name).toBe('current')
  })

  it('only refreshes the active composition and uses the projection for its selected preset', async () => {
    const h = await harness()
    const calls = h.client.listSkills.mock.calls.length
    h.emit({ type: 'host/session-composition-changed', sessionId: 'b' })
    expect(h.client.listSkills).toHaveBeenCalledTimes(calls)
    h.emit({ type: 'host/session-composition-changed', sessionId: 'a' })
    expect(h.controller.state.agentPreset.current).toBe('standard')
    h.emit({ type: 'session/projection', sessionId: 'a', key: 'agentPreset', value: 'minimal' }, 'mux')
    await vi.waitFor(() => expect(h.controller.state.agentPreset.current).toBe('minimal'))
    expect(h.client.listSkills.mock.calls.length).toBeGreaterThan(calls)
  })

  it('preserves the working sidebar after a background discovery failure and retries on the next notification', async () => {
    const h = await harness()
    h.client.models.mockRejectedValueOnce(new Error('temporary catalog failure'))
    h.emit({ type: 'host/settings-changed', ns: 'llm', revision: 2 })
    await vi.waitFor(() => expect(h.output.appendLine).toHaveBeenCalledWith(expect.stringContaining('temporary catalog failure')))
    expect(h.controller.state.phase).toBe('ready')
    expect(h.controller.state.models[0]?.model).toBe('model')
    h.client.models.mockResolvedValue(models('recovered'))
    h.emit({ type: 'host/models-changed' })
    await vi.waitFor(() => expect(h.controller.state.models[0]?.model).toBe('recovered'))
  })

  it('waits for a refreshed catalog before dispatching a newly added slash command', async () => {
    const h = await harness()
    const pending = Promise.withResolvers<Array<{ name: string; description: string }>>()
    h.client.listCommands.mockReturnValue(pending.promise)
    h.emit({ type: 'host/session-composition-changed', sessionId: 'a' })
    expect(h.controller.state.commands).toEqual([])
    const send = h.controller.send('/new-command')
    expect(h.client.prompt).not.toHaveBeenCalled()
    expect(h.client.executeCommand).not.toHaveBeenCalled()
    pending.resolve([{ name: 'new-command', description: '' }])
    await send
    expect(h.client.executeCommand).toHaveBeenCalledWith('a', '/new-command', undefined)
    expect(h.client.prompt).not.toHaveBeenCalled()
  })

  it('routes from the latest catalog, preserving unknown slash text and skill input', async () => {
    const h = await harness()
    h.client.listCommands.mockResolvedValue([])
    await h.controller.send('/plan is plain text now')
    expect(h.client.prompt).toHaveBeenCalledWith('a', '/plan is plain text now', [], 'queue')
    expect(h.client.executeCommand).not.toHaveBeenCalled()
    h.client.listSkills.mockResolvedValue([{ name: 'review', description: '', modelInvocable: true }])
    const context = { activeFile: { kind: 'file' as const, path: 'code.ts' }, mentions: [], pinned: [] }
    await h.controller.send('/review code', [], context)
    expect(h.client.prompt).toHaveBeenLastCalledWith('a', '/review code', [], 'queue')
    h.client.listCommands.mockRejectedValue(new Error('catalog unavailable'))
    await expect(h.controller.send('/unknown')).rejects.toThrow('catalog unavailable')
    expect(h.client.prompt).toHaveBeenCalledTimes(2)
    await h.controller.send('hello')
    expect(h.client.prompt).toHaveBeenLastCalledWith('a', 'hello', [], 'queue')
  })

  it('does not dispatch a slash input after the conversation changed during discovery', async () => {
    const h = await harness()
    const pending = Promise.withResolvers<Array<{ name: string; description: string }>>()
    h.client.listCommands.mockReturnValueOnce(pending.promise)
    const send = h.controller.send('/plan')
    const rejected = expect(send).rejects.toThrow('conversation changed')
    await h.controller.selectSession('b')
    await h.controller.selectSession('a')
    pending.resolve([{ name: 'plan', description: '' }])
    await rejected
    expect(h.client.executeCommand).not.toHaveBeenCalled()
    expect(h.client.prompt).not.toHaveBeenCalled()
  })

  it.each(['resolve', 'reject'])('does not replace a newer projected preset after a delayed local %s', async outcome => {
    const h = await harness()
    const pending = Promise.withResolvers<{ agentPreset: string }>()
    h.client.selectAgentPreset.mockReturnValueOnce(pending.promise)
    const selection = h.controller.selectAgentPreset('minimal')
    const settled = selection.catch(error => error)
    h.emit({ type: 'session/projection', sessionId: 'a', key: 'agentPreset', value: 'minimal' }, 'mux')
    h.emit({ type: 'session/projection', sessionId: 'a', key: 'agentPreset', value: 'standard' }, 'mux')
    if (outcome === 'resolve') pending.resolve({ agentPreset: 'minimal' })
    else pending.reject(new Error('old operation failed'))
    await settled
    expect(h.controller.state.agentPreset.current).toBe('standard')
    expect(h.controller.state.agentPreset.busy).toBe(false)
  })

  it('notifies an open settings picker and refuses to save a draft into a replacement runtime', async () => {
    const h = await harness()
    const listener = vi.fn()
    h.controller.onDidChangeRuntimeSettings(listener)
    h.emit({ type: 'host/settings-changed', ns: 'test', revision: 2 })
    expect(listener).toHaveBeenCalledTimes(1)
    h.emit({ type: 'host/credentials-changed' })
    expect(listener).toHaveBeenCalledTimes(2)
    const namespace = { ns: 'test', revision: 1 }
    h.client.settings.mockResolvedValue({ namespaces: [namespace] })
    const draft = (await h.controller.settings()).namespaces[0]!
    await h.controller.mutateSettings(draft, [])
    expect(h.client.mutateSettings).toHaveBeenCalledWith('test', [], 1)
    const replacement = { ...h.client, mutateSettings: vi.fn() }
    mocks.client = replacement
    await h.controller.start()
    expect(() => h.controller.mutateSettings(draft, [])).toThrow('runtime changed')
    expect(replacement.mutateSettings).not.toHaveBeenCalled()
  })

  it('rejects inventory results from a replaced runtime', async () => {
    const h = await harness()
    const pending = Promise.withResolvers<{ entries: [] }>()
    h.client.pluginInventory.mockReturnValueOnce(pending.promise)
    const inventory = h.controller.pluginInventory()
    const rejected = expect(inventory).rejects.toThrow('runtime changed')
    mocks.client = { ...h.client }
    await h.controller.start()
    pending.resolve({ entries: [] })
    await rejected
  })
})
