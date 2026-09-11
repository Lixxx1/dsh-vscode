import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DshClient, type DshFrame } from '../src/dsh-client.js'
import type { DshConnection } from '../src/dsh-connection.js'
import { DshConnectionError } from '../src/dsh-connection.js'
import { decodeHistory } from '../src/dsh-history.js'
import { ConversationProjector } from '../src/conversation.js'

const clients: DshClient[] = []
afterEach(() => { for (const client of clients.splice(0)) client.dispose(); vi.useRealTimers() })

const event = (seq: number, text = 'hello') => ({
  type: 'event', event: { seq, time: seq * 10, type: 'assistant/chunk', data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text } } },
})
const snapshot = (id = 's', cursor = 5, values: Record<string, unknown> = {}) => ({
  type: 'snapshot', header: { id }, cursor, records: [event(cursor)], hasMore: true, projections: { asOfSeq: cursor, values },
})

function harness(autoSnapshot = true) {
  const requests: { endpoint: string; args: any }[] = []
  const outgoing: any[] = []
  const ids = new Map<string, string>()
  const frames: DshFrame[] = []
  const errors: Error[] = []
  const results: Record<string, unknown> = {
    'session/list': { items: [] }, 'session/create': { sessionId: 's' },
    'session/modelCatalog': { default: { provider: 'p', model: 'm' }, routableProviders: ['p'], groups: [], failures: [] },
    'session/page': { records: [event(1)], hasMore: false },
    'skills/list': { skills: [] }, 'agentPresets/list': { presets: [] }, 'agentPresets/select': 'coding',
  }
  const socket = new EventEmitter() as EventEmitter & { readyState: number; send: (raw: string) => void; terminate: () => void }
  socket.readyState = 0
  const receive = (id: string, value: unknown) => socket.emit('message', Buffer.from(JSON.stringify({ type: 'item', streamId: id, value })), false)
  const push = (endpoint: string, value: unknown) => receive(ids.get(endpoint)!, value)
  socket.send = raw => {
    const frame = JSON.parse(raw)
    outgoing.push(frame)
    if (frame.type !== 'open') return
    ids.set(frame.endpoint, frame.streamId)
    queueMicrotask(() => {
      if (frame.endpoint === '$events') receive(frame.streamId, { type: 'ready', clientId: 'client-1', host: { home: '/isolated' } })
      if (frame.endpoint === 'session/control') receive(frame.streamId, { type: 'baseline', value: { queues: {}, jobs: {}, projections: {} } })
      if (frame.endpoint === 'workspace/follow') receive(frame.streamId, { type: 'baseline', value: { items: [], archivedSessionIds: ['archived'] } })
      if (frame.endpoint === 'session/follow' && autoSnapshot) receive(frame.streamId, snapshot(frame.payload.args.request.address.sessionId))
    })
  }
  socket.terminate = () => { socket.readyState = 3; socket.emit('close') }
  const connection = {
    call: vi.fn(async (endpoint: string, args: unknown) => {
      requests.push({ endpoint, args })
      if (endpoint === 'commands/execute' && (args as any).line === '') {
        throw new DshConnectionError('gateway/arguments-invalid', 'typert gateway: commands/execute: args fields do not match the descriptor: missing "images"; unexpected "submittedAttachments"')
      }
      return results[endpoint] ?? { accepted: true }
    }),
    openStreamSocket: vi.fn(() => {
      queueMicrotask(() => { socket.readyState = 1; socket.emit('open') })
      return socket
    }),
  } as unknown as DshConnection
  const client = new DshClient(connection)
  clients.push(client)
  client.onFrame(frame => frames.push(frame))
  client.onError(error => errors.push(error))
  return { client, connection, socket, requests, outgoing, frames, errors, results, ids, push, receive }
}

describe('DSH 0.1.2 chat transport', () => {
  it('forwards the actual discovery events and does not publish credential references', async () => {
    const h = harness()
    await h.client.startStreams()
    for (const [event, args] of [
      ['commands/change', []], ['llm/adapters-updated', []], ['credentials/reference-updated', ['SECRET_REFERENCE']],
      ['settings/document-updated', ['llm-deepseek', 3]], ['agent-preset/selected', ['s', 'minimal']],
    ]) h.push('$events', { type: 'emit', event, args })
    expect(h.frames.map(f => f.payload)).toEqual([
      { type: 'host/commands-changed' }, { type: 'host/models-changed' }, { type: 'host/credentials-changed' },
      { type: 'host/settings-changed', ns: 'llm-deepseek', revision: 3 },
      { type: 'host/session-composition-changed', sessionId: 's' },
    ])
    expect(JSON.stringify(h.frames)).not.toContain('SECRET_REFERENCE')
    expect(h.errors).toEqual([])
  })

  it('invalidates command catalogs globally, skills only for the recomposed session, and presets on settings changes', async () => {
    const h = harness()
    h.results['commands/list'] = [{ name: 'plan', description: 'Plan' }]
    await h.client.startStreams()
    await h.client.listCommands('a'); await h.client.listCommands('b')
    await h.client.listSkills('a'); await h.client.listSkills('b')
    await h.client.listAgentPresets()
    const count = (endpoint: string) => h.requests.filter(r => r.endpoint === endpoint).length
    h.push('$events', { type: 'emit', event: 'commands/change', args: [] })
    h.results['commands/list'] = []
    expect(await h.client.listCommands('a')).toEqual([])
    expect(await h.client.listCommands('b')).toEqual([])
    expect(count('commands/list')).toBe(4)
    h.push('$events', { type: 'emit', event: 'agent-preset/selected', args: ['a', 'minimal'] })
    await h.client.listSkills('a'); await h.client.listSkills('b')
    expect(count('skills/list')).toBe(3)
    h.push('$events', { type: 'emit', event: 'settings/document-updated', args: ['agent-presets', 1] })
    await h.client.listAgentPresets()
    expect(count('agentPresets/list')).toBe(2)
  })

  it('discards an old model catalog when settings or credentials change during its request', async () => {
    const h = harness()
    await h.client.startStreams()
    const first = Promise.withResolvers<unknown>()
    vi.mocked(h.connection.call).mockImplementationOnce(() => first.promise as any)
    const pending = h.client.models('s')
    h.push('$events', { type: 'emit', event: 'llm/adapters-updated', args: [] })
    h.push('$events', { type: 'emit', event: 'settings/document-updated', args: ['llm-deepseek', 1] })
    h.push('$events', { type: 'emit', event: 'credentials/reference-updated', args: ['API_KEY'] })
    h.results['session/modelCatalog'] = { default: { provider: 'new', model: 'new' }, routableProviders: ['new'], groups: [], failures: [] }
    first.resolve({ default: { provider: 'old', model: 'old' }, routableProviders: [], groups: [], failures: [] })
    expect(await pending).toMatchObject({ current: { provider: 'new', model: 'new' }, routable: true })
    expect(h.client.currentModels('s')).toMatchObject({ current: { provider: 'new', model: 'new' } })
  })

  it('reopening a session refetches its command and skill catalogs', async () => {
    const h = harness()
    await h.client.startStreams()
    h.results['commands/list'] = [{ name: 'old' }]
    await h.client.listCommands('s'); await h.client.listSkills('s')
    const opening = await h.client.openSession('s')
    opening.activate()
    h.results['commands/list'] = [{ name: 'new' }]
    expect(await h.client.listCommands('s')).toEqual([{ name: 'new' }])
    await h.client.listSkills('s')
    expect(h.requests.filter(r => r.endpoint === 'skills/list')).toHaveLength(2)
  })

  it('multiplexes all baselines through one connection and uses named Remote arguments', async () => {
    const h = harness()
    await h.client.startStreams()
    await h.client.startStreams()
    expect(h.connection.openStreamSocket).toHaveBeenCalledTimes(1)
    expect(h.outgoing.map(f => f.endpoint)).toEqual(['$events', 'session/control', 'workspace/follow'])
    expect(h.outgoing.every(f => JSON.stringify(f.payload) === '{"args":{}}')).toBe(true)
    expect(await h.client.listWorkspaces()).toEqual({ archivedSessionIds: ['archived'] })
    await h.client.prompt('s', 'Change direction', [], 'steer')
    await h.client.updateQueue('s', 'item', { kind: 'steer' })
    await h.client.cancel('s')
    expect(h.requests).toMatchObject([
      { endpoint: 'session/prompt', args: { request: { requestId: expect.any(String), sessionId: 's', mode: 'steer', content: [{ type: 'text', text: 'Change direction' }] } } },
      { endpoint: 'session/updateQueue', args: { request: { sessionId: 's', itemId: 'item', action: { kind: 'steer' } } } },
      { endpoint: 'session/cancel', args: { request: { sessionId: 's' } } },
    ])
  })

  it('preserves rename, archive, image, plugin, settings and command contracts', async () => {
    const h = harness()
    await h.client.renameSession('s', 'Renamed')
    await h.client.archiveSession('s')
    await h.client.attachment('s', 'image')
    await h.client.pluginInventory()
    await h.client.settings()
    await h.client.mutateSettings('ns', [{ op: 'set', path: ['x'], value: 1 }], 3)
    await h.client.listSkills('s')
    expect(await h.client.selectAgentPreset('s', 'coding')).toEqual({ agentPreset: 'coding' })
    await h.client.executeCommand('s', '/compact')
    await h.client.executeCommand('s', '/plan inspect', [{ type: 'image', mediaType: 'image/png', data: 'YWJj', name: 'image.png' }])
    expect(h.requests).toEqual([
      { endpoint: 'session/rename', args: { request: { sessionId: 's', title: 'Renamed' } } },
      { endpoint: 'workspace/archiveSession', args: { request: { sessionId: 's' } } },
      { endpoint: 'session/attachment', args: { request: { sessionId: 's', attachmentId: 'image' } } },
      { endpoint: 'pluginInventory/list', args: {} }, { endpoint: 'settings/describe', args: {} },
      { endpoint: 'settings/mutate', args: { ns: 'ns', ops: [{ op: 'set', path: ['x'], value: 1 }], expectedRevision: 3 } },
      { endpoint: 'skills/list', args: { request: { sessionId: 's' } } },
      { endpoint: 'agentPresets/select', args: { agentId: 's', agentPreset: 'coding' } },
      { endpoint: 'commands/execute', args: { agentId: 's', line: '', submittedAttachments: [] } },
      { endpoint: 'commands/execute', args: { agentId: 's', line: '/compact', images: [] } },
      { endpoint: 'commands/execute', args: { agentId: 's', line: '/plan inspect', images: [{ mediaType: 'image/png', data: 'YWJj', name: 'image.png' }] } },
    ])
  })

  it('buffers post-snapshot events until activation, and pins pagination to the opening cursor', async () => {
    const h = harness()
    await h.client.startStreams()
    const opening = await h.client.openSession('s')
    h.push('session/follow', event(6, ' world'))
    expect(h.frames.filter(f => f.payload.type === 'session/event')).toHaveLength(0)
    opening.activate()
    opening.activate()
    expect(h.frames.filter(f => f.payload.type === 'session/event')).toHaveLength(1)
    const projector = new ConversationProjector()
    projector.reset(opening.events)
    for (const frame of h.frames.filter(f => f.payload.type === 'session/event')) projector.apply(frame.payload.event as any)
    expect(projector.messages()[0]?.text).toBe('hello world')
    await h.client.history('s', 5)
    expect(h.requests.at(-1)).toEqual({ endpoint: 'session/page', args: { request: { address: { kind: 'session', sessionId: 's' }, throughSeq: 5, beforeSeq: 5, maxMessages: 100 } } })
  })

  it('opts into 0.1.5 streaming, buffers the live baseline and settlement, and keeps history cursors durable', async () => {
    const h = harness(false)
    await h.client.startStreams()
    const pending = h.client.openSession('s')
    expect(h.outgoing.at(-1).payload.args.request.assistantStream).toBe(true)
    h.push('session/follow', { ...snapshot(), records: [], assistantStream: { revision: 2, activeAttempt: {
      attemptId: 'a', turn: 1, step: 1, startedAfterSeq: 5, nextIndex: 1,
      stream: [{ type: 'text-chunks', time0: 10, index: 0, dt: [], texts: ['Hello'] }],
    } } })
    const opening = await pending
    h.push('session/follow', { type: 'assistant-stream', frame: {
      type: 'chunk', attemptId: 'a', revision: 3, index: 1, time: 20, chunk: { type: 'text-delta', index: 0, text: ' world' },
    } })
    h.push('session/follow', { type: 'event', event: { type: 'assistant/message', seq: 6, time: 30, surfaceOp: 'append',
      data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'Hello world' }] }, stream: [] },
    } })
    h.push('session/follow', { type: 'assistant-stream', frame: { type: 'end', attemptId: 'a', revision: 4, index: 2,
      outcome: { kind: 'committed', eventType: 'assistant/message', seq: 6 },
    } })
    expect(opening.events).toEqual([])
    expect(h.frames).toEqual([])
    opening.activate()
    const projector = new ConversationProjector()
    for (const frame of h.frames) {
      if (frame.payload.type === 'session/assistant-stream') projector.applyStream(frame.payload.update as any)
      if (frame.payload.type === 'session/event') projector.apply(frame.payload.event as any)
    }
    expect(projector.messages()).toEqual([{ id: 'assistant:1:1', role: 'assistant', text: 'Hello world' }])
    expect(h.frames.filter(f => f.payload.type === 'session/event')).toHaveLength(1)
    await h.client.history('s', 5)
    expect(h.requests.at(-1)?.args.request).toMatchObject({ throughSeq: 5, beforeSeq: 5 })
    // The next durable seq follows 6, not the number of transient chunks.
    h.push('session/follow', { type: 'event', event: { seq: 7, time: 40, type: 'turn/end', data: { turn: 1 } } })
    expect(h.errors).toEqual([])
  })

  it('does not leak a cancelled live prefix into another subscription', async () => {
    const h = harness(false)
    await h.client.startStreams()
    const first = h.client.openSession('a')
    h.push('session/follow', { ...snapshot('a'), assistantStream: { revision: 0 } })
    const old = await first
    const oldId = h.ids.get('session/follow')!
    h.push('session/follow', { type: 'assistant-stream', frame: { type: 'start', attemptId: 'old', revision: 1, turn: 1, step: 1, startedAfterSeq: 5 } })
    const second = h.client.openSession('b')
    h.push('session/follow', { ...snapshot('b'), assistantStream: { revision: 0 } })
    const current = await second
    old.activate(); current.activate()
    h.receive(oldId, { type: 'assistant-stream', frame: { type: 'chunk', attemptId: 'old', revision: 2, index: 0, time: 10, chunk: { type: 'text-delta', text: 'Stale' } } })
    expect(h.frames.some(f => f.payload.type === 'session/assistant-stream')).toBe(false)
    expect(h.errors).toEqual([])
  })

  it('cancels stale subscriptions including A → B → A and ignores late frames', async () => {
    const h = harness(false)
    await h.client.startStreams()
    const first = h.client.openSession('a')
    const rejection = expect(first).rejects.toThrow('subscription changed')
    const oldId = h.ids.get('session/follow')!
    const second = h.client.openSession('b')
    const secondRejection = expect(second).rejects.toThrow('subscription changed')
    const third = h.client.openSession('a')
    h.receive(oldId, snapshot('a'))
    h.push('session/follow', snapshot('a'))
    const opening = await third
    await rejection
    await secondRejection
    opening.activate()
    h.receive(oldId, event(6))
    expect(h.outgoing.filter(f => f.type === 'cancel')).toHaveLength(2)
    expect(h.frames.filter(f => f.payload.type === 'session/event')).toHaveLength(0)
  })

  it('merges newer control projections but never lets an older control frame overwrite the snapshot', async () => {
    const h = harness(false)
    await h.client.startStreams()
    h.push('session/control', { type: 'projection', sessionId: 's', key: 'modelSelection', seq: 7, value: { next: { provider: 'p', model: 'new', reasoningEffort: 'high' } } })
    const pending = h.client.openSession('s')
    h.push('session/follow', snapshot('s', 5, { modelSelection: { next: { provider: 'p', model: 'old' } }, title: 'snapshot' }))
    const opening = await pending
    h.push('session/control', { type: 'projection', sessionId: 's', key: 'title', seq: 4, value: 'stale' })
    h.push('session/control', { type: 'projection', sessionId: 's', key: 'removed-capability', seq: 4, value: 'stale' })
    expect((await h.client.models('s')).current).toEqual({ provider: 'p', model: 'new', reasoningEffort: 'high' })
    opening.activate()
    expect(h.frames.filter(f => f.payload.key === 'title').map(f => f.payload.value)).toEqual(['snapshot'])
    expect(h.frames.some(f => f.payload.key === 'removed-capability')).toBe(false)
    h.push('session/control', { type: 'projection', sessionId: 's', key: 'modelSelection', seq: 8, value: { lastUsed: { provider: 'missing', model: 'm' }, next: null } })
    expect(h.client.currentModels('s')).toMatchObject({ routable: false, current: { provider: 'missing', model: 'm' } })
  })

  it('returns approvals and questions via $events/result and clears cancelled requests', async () => {
    const h = harness()
    await h.client.startStreams()
    const opening = await h.client.openSession('s')
    opening.activate()
    h.push('$events', { type: 'waterfall', eventId: 'approval', agentId: 's', event: 'approval/request', request: { toolName: 'Write', reason: 'Permission' } })
    expect(h.frames.at(-1)).toMatchObject({ rpcId: 'approval', payload: { type: 'approval/requested', approvalId: 'approval', toolName: 'Write' } })
    await h.client.respond('approval', { sessionId: 's', outcome: 'allowed-once' })
    expect(h.requests.at(-1)).toEqual({ endpoint: '$events/result', args: { clientId: 'client-1', eventId: 'approval', outcome: { kind: 'result', value: 'allowed-once' } } })
    await expect(h.client.respond('approval', { sessionId: 's', outcome: 'allowed-once' })).rejects.toThrow('no longer pending')
    h.push('$events', { type: 'waterfall', eventId: 'question', agentId: 's', event: 'user-questions/request', request: { questions: [{ id: 'q', question: 'Which?' }] } })
    await h.client.respond('question', { sessionId: 's', answer: { answers: [{ id: 'q', selected: ['yes'] }] } })
    expect(h.requests.at(-1)?.args.outcome).toEqual({ kind: 'result', value: { answers: [{ id: 'q', selected: ['yes'] }] } })
    h.push('$events', { type: 'waterfall', eventId: 'cancelled', agentId: 's', event: 'approval/request', request: { toolName: 'Write' } })
    h.push('$events', { type: 'cancel', eventId: 'cancelled' })
    expect(h.frames.at(-1)?.payload.type).toBe('approval/resolved')
    await expect(h.client.respond('cancelled', { sessionId: 's', outcome: 'allowed-once' })).rejects.toThrow()
  })

  it('delegates unsupported or other-session waterfalls without granting permission', async () => {
    const h = harness()
    await h.client.startStreams()
    h.push('$events', { type: 'waterfall', eventId: 'other', agentId: 'elsewhere', event: 'approval/request', request: { toolName: 'Write' } })
    await Promise.resolve()
    expect(h.requests.at(-1)?.args.outcome).toEqual({ kind: 'next' })
    expect(h.frames.some(f => f.payload.type === 'approval/requested')).toBe(false)
  })

  it('fails closed on event gaps, fails pending opens on disconnect, and does not replay mutations', async () => {
    const h = harness()
    await h.client.startStreams()
    const opening = await h.client.openSession('s')
    opening.activate()
    h.push('session/follow', event(9))
    expect(h.errors).toHaveLength(1)
    expect(h.frames.filter(f => f.payload.type === 'session/event')).toHaveLength(0)
    expect(h.connection.openStreamSocket).toHaveBeenCalledTimes(1)
    const disconnected = harness(false)
    await disconnected.client.startStreams()
    const pending = disconnected.client.openSession('s')
    const assertion = expect(pending).rejects.toThrow('closed')
    disconnected.socket.emit('close')
    await assertion
    expect(disconnected.errors).toHaveLength(1)
  })

  it('rejects pending snapshot reads on disposal', async () => {
    const h = harness(false)
    await h.client.startStreams()
    const pending = h.client.openSession('s')
    const assertion = expect(pending).rejects.toThrow()
    h.client.dispose()
    await assertion
    expect(h.errors).toHaveLength(0)
  })

  it('invalidates an already resolved snapshot when disconnected before activation', async () => {
    const h = harness()
    await h.client.startStreams()
    const opening = await h.client.openSession('s')
    expect(opening.isCurrent()).toBe(true)
    h.push('session/follow', event(6))
    h.socket.emit('close')
    expect(opening.isCurrent()).toBe(false)
    opening.activate()
    expect(h.frames.filter(f => f.payload.type === 'session/event')).toHaveLength(0)
    await expect(h.client.openSession('s')).rejects.toThrow('closed')
  })

  it('queues concurrent approvals and advances to the next unanswered request', async () => {
    const h = harness()
    await h.client.startStreams()
    const opening = await h.client.openSession('s')
    opening.activate()
    for (const eventId of ['a', 'b']) h.push('$events', { type: 'waterfall', eventId, agentId: 's', event: 'approval/request', request: { toolName: 'Write' } })
    expect(h.frames.at(-1)?.rpcId).toBe('a')
    expect(h.frames.filter(f => f.payload.type === 'approval/requested')).toHaveLength(1)
    await h.client.respond('a', { sessionId: 's', outcome: 'rejected' })
    expect(h.frames.at(-1)).toMatchObject({ rpcId: 'b', payload: { type: 'approval/requested' } })
    await h.client.respond('b', { sessionId: 's', outcome: 'rejected' })
    expect(h.frames.at(-1)?.payload.type).toBe('approval/resolved')
  })

  it('uses the latest queue and jobs baseline when switching conversations', async () => {
    const h = harness()
    await h.client.startStreams()
    const opening = await h.client.openSession('s')
    h.push('session/control', { type: 'queue', sessionId: 's', items: [{ id: 'queued' }] })
    h.push('session/control', { type: 'jobs', sessionId: 's', jobs: [{ id: 'job' }] })
    opening.activate()
    expect(h.frames.find(f => f.payload.type === 'session/queue')?.payload.items).toEqual([{ id: 'queued' }])
    expect(h.frames.find(f => f.payload.type === 'session/jobs')?.payload.jobs).toEqual([{ id: 'job' }])
    const second = await h.client.openSession('other')
    second.activate()
    expect(h.frames.filter(f => f.payload.type === 'session/queue').at(-1)?.payload.items).toEqual([])
  })

  it('times out missing snapshots and cancels their logical stream', async () => {
    vi.useFakeTimers()
    const h = harness(false)
    await h.client.startStreams()
    const pending = h.client.openSession('s')
    const rejection = expect(pending).rejects.toThrow('timed out')
    await vi.advanceTimersByTimeAsync(30_000)
    await rejection
    expect(h.outgoing.at(-1)?.type).toBe('cancel')
  })
})

describe('packed DSH history', () => {
  it('expands text, reasoning and tool chunks with exact sequences and timestamps', () => {
    const records = [
      { type: 'chunks', event: { type: 'chunkrow/text-chunks', seq: 1, time: 100, data: { turn: 1, step: 1, index: 0, dt: [2, -1], texts: ['a', 'b', 'c'] } } },
      { type: 'chunks', event: { type: 'chunkrow/reasoning-chunks', seq: 4, time: 102, data: { turn: 1, step: 1, index: 1, dt: [], texts: ['reason'] } } },
      { type: 'chunks', event: { type: 'chunkrow/tool-call-chunks', seq: 5, time: 103, data: { turn: 1, step: 1, index: 2, id: 'call', name: 'Read', dt: [1], args: ['{', '}'] } } },
    ]
    const decoded = decodeHistory(records)
    expect(decoded.map(r => r.event.seq)).toEqual([1, 2, 3, 4, 5, 6])
    expect(decoded.map(r => r.event.time)).toEqual([100, 102, 101, 102, 103, 104])
    expect(decoded[5]?.event.data).toEqual({ turn: 1, step: 1, chunk: { type: 'tool-call-delta', index: 2, id: 'call', name: 'Read', argumentsDelta: '}' } })
    const projector = new ConversationProjector()
    projector.reset(decoded)
    expect(projector.messages()[0]?.text).toBe('abc')
  })
  it('rejects malformed or unknown packed records instead of dropping content', () => {
    expect(() => decodeHistory([{ type: 'chunks', event: { type: 'chunkrow/text-chunks', seq: 0, time: 0, data: { texts: ['a'], dt: [1] } } }])).toThrow()
    expect(() => decodeHistory([{ type: 'chunks', event: { type: 'chunkrow/unknown', seq: 0, time: 0, data: {} } }])).toThrow()
  })
})
