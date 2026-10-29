import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { subagentCatalog, subagentProgress, readSubagentTasks, subagentDetail } from '../src/subagents.js'
import { inspectSubagents, readChildSnapshot } from '../src/dsh-subagents.js'
import type { DshConnection } from '../src/dsh-connection.js'
import type { HistoryEntry } from '../src/dsh-client.js'

const child = (id: string) => ({ id, label: `Task ${id}`, mode: 'continuable' })
const signal = () => new AbortController().signal
function toolEntries(id: string, input: string, output: string, failed = false, version = 'V4'): HistoryEntry[] {
  const content = [{ type: 'text', text: output }]
  return [
    { event: { type: 'tool/call', seq: 1, time: 1, data: { callId: id, name: 'Bash', arguments: input } } },
    { event: { type: 'tool/result', seq: 2, time: 2, data: { message: version === 'V4'
      ? { source: { callId: id }, isError: failed, content }
      : { content: [{ type: 'tool-result', toolCallId: id, isError: failed, content }] } } } },
  ]
}

describe('read-only subagent tasks', () => {
  it('validates and deduplicates parent-owned catalogs', () => {
    expect(subagentCatalog([child('a'), child('a'), { id: 'b', mode: 'unknown' }, {}, { id: 'bad', mode: 'invalid' }]))
      .toEqual([{ id: 'a', label: 'Task a', mode: 'continuable' }, { id: 'b', label: 'Agent b', mode: 'unknown' }])
    expect(subagentCatalog({ children: [child('a')] })).toEqual([])
  })
  it('never equates idle with success or an old open turn with live execution', () => {
    expect(subagentProgress({})).toEqual({ status: 'inactive', elapsedMs: 0 })
    expect(subagentProgress({ subagentTiming: { settledMs: 12, active: { since: 30, through: 40 } } }, false))
      .toEqual({ status: 'inactive', elapsedMs: 22 })
    expect(subagentProgress({ subagentTiming: { lastTurnCompleted: true } }).status).toBe('completed')
    expect(subagentProgress({ subagentTiming: { lastTurnCompleted: false } }).status).toBe('interrupted')
    expect(subagentProgress({ subagentTiming: { lastTurnCompleted: true } }, true).status).toBe('running')
  })
  it('walks direct links in stable order, isolates missing children and breaks cycles', async () => {
    const values: Record<string, any> = {
      root: { subagentCatalog: [child('a'), child('missing'), child('broken'), child('b')] },
      a: { subagentCatalog: [child('root'), child('nested')] },
      nested: { subagentTiming: { lastTurnCompleted: true } },
      b: {},
    }
    const read = vi.fn(async (id: string) => { if (id === 'broken') throw new Error('offline'); return values[id] ?? null })
    const result = await readSubagentTasks('root', read, id => id === 'a', signal())
    expect(result.tasks.map(task => [task.address.parentSessionId, task.address.childSessionId, task.depth, task.status]))
      .toEqual([['root', 'a', 0, 'running'], ['a', 'nested', 1, 'completed'], ['root', 'missing', 0, 'unavailable'],
        ['root', 'broken', 0, 'unavailable'], ['root', 'b', 0, 'inactive']])
    expect(read.mock.calls.flat()).toEqual(['root', 'a', 'nested', 'missing', 'broken', 'b'])
  })
  it('bounds large catalogs and deep trees', async () => {
    const wide = await readSubagentTasks('root', async id => id === 'root'
      ? { subagentCatalog: Array.from({ length: 60 }, (_, index) => child(String(index))) } : {}, () => false, signal())
    expect(wide.tasks).toHaveLength(40); expect(wide.truncated).toBe(true)
    const deep = await readSubagentTasks('0', async id => ({ subagentCatalog: [child(String(Number(id) + 1))] }), () => false, signal())
    expect(deep.tasks).toHaveLength(5); expect(deep.truncated).toBe(true)
  })
  it('stops discovery when closed rather than issuing further reads', async () => {
    const abort = new AbortController()
    const read = vi.fn(async () => { abort.abort(); return { subagentCatalog: [child('a')] } })
    await expect(readSubagentTasks('root', read, () => false, abort.signal)).rejects.toThrow()
    expect(read).toHaveBeenCalledTimes(1)
  })
  it('rejects detail requests outside the current parent tree before opening any stream', async () => {
    const connection = { call: vi.fn(async () => ({ values: { subagentCatalog: [] } })), openStreamSocket: vi.fn() }
    await expect(inspectSubagents(connection as any, 'root', 'foreign', () => false, signal())).rejects.toThrow('task catalog')
    expect(connection.openStreamSocket).not.toHaveBeenCalled()
    expect(connection.call).toHaveBeenCalledWith('session/projections', { request: { sessionId: 'root' } }, 10_000, expect.any(AbortSignal))
  })
  it.each(['V3', 'V4'])('includes recorded tool arguments and success/error output for %s', version => {
    const input = JSON.stringify({ command: 'node debug-demo.js' })
    for (const failed of [false, true]) {
      const output = failed ? 'Error: ENOENT: no such file, invoice.json' : 'Invoice total: $36\nExit 0'
      expect(subagentDetail('a', toolEntries('call', input, output, failed, version), false)).toEqual({
        childSessionId: 'a', truncated: false,
        messages: [{ id: 'tool:call', role: 'tool', text: 'Bash', detail: failed ? 'Failed' : 'Completed', failed, rawInput: input, rawResult: output }],
      })
    }
  })
  it('keeps arguments for running tools and results when the call is outside the history window', () => {
    const entries = toolEntries('call', '{"command":"pwd"}', '/workspace')
    expect(subagentDetail('a', entries.slice(0, 1), false).messages).toEqual([
      { id: 'tool:call', role: 'tool', text: 'Bash', detail: 'Running…', failed: false, rawInput: '{"command":"pwd"}' },
    ])
    expect(subagentDetail('a', entries.slice(1), true)).toEqual({
      childSessionId: 'a', truncated: true,
      messages: [{ id: 'tool:call', role: 'tool', text: 'Tool', detail: 'Completed', failed: false, rawResult: '/workspace' }],
    })
  })
  it('bounds tool inputs and results within the shared budget, preserving newest output first', () => {
    const entries = Array.from({ length: 10 }, (_, index) => toolEntries(String(index), 'i'.repeat(10_000), `Output ${index} ` + 'x'.repeat(10_000)))
      .flat().map((entry, seq) => ({ ...entry, event: { ...entry.event, seq, time: seq } }))
    const detail = subagentDetail('a', entries, false)
    expect(detail.truncated).toBe(true)
    expect(detail.messages.map(message => message.id)).toEqual(['tool:6', 'tool:7', 'tool:8', 'tool:9'])
    const fields = detail.messages.flatMap(message => [message.text, message.detail, message.rawInput ?? '', message.rawResult ?? ''])
    expect(fields.every(text => text.length <= 8_000)).toBe(true)
    expect(fields.reduce((sum, text) => sum + text.length, 0)).toBe(60_000)
    expect(detail.messages.at(-1)?.rawResult).toBe(('Output 9 ' + 'x'.repeat(10_000)).slice(0, 8_000))
    expect(detail.messages[0]?.rawResult).toHaveLength(8_000)
    expect(detail.messages[0]?.rawInput?.length).toBeLessThan(8_000)
  })
  it('excludes tool views and image blocks while retaining text unchanged', () => {
    const text = '<img src=x onerror="alert(1)">\n[open](command:workbench.action.files.openFile)'
    const entries = toolEntries('call', '{"command":"pwd"}', text)
    const result = entries[1]!
    result.event.data = { message: { source: { callId: 'call' }, content: [
      { type: 'text', text }, { type: 'image', data: 'PRIVATE_IMAGE_DATA', attachment: { attachmentId: 'image', mediaType: 'image/png', width: 1, height: 1 } },
    ] } }
    const detail = subagentDetail('a', entries, false)
    expect(detail.messages[0]?.rawResult).toBe(text)
    expect(detail.messages[0]).not.toHaveProperty('callView')
    expect(detail.messages[0]).not.toHaveProperty('resultView')
    expect(detail.messages[0]).not.toHaveProperty('images')
    expect(JSON.stringify(detail)).not.toContain('PRIVATE_IMAGE_DATA')
  })
  it('bounds assistant output while preserving the newest messages', () => {
    const detail = subagentDetail('a', Array.from({ length: 70 }, (_, seq) => ({ event: {
      type: 'assistant/message', seq, time: seq, surfaceOp: 'append' as const,
      data: { turn: seq, step: 1, message: { content: [{ type: 'text', text: `Output ${seq} ` + 'x'.repeat(10_000) }] } },
    } })), false)
    expect(detail.truncated).toBe(true)
    expect(detail.messages.at(-1)?.text).toContain('Output 69')
    expect(detail.messages.reduce((sum, message) => sum + message.text.length + message.detail.length, 0)).toBeLessThanOrEqual(60_000)
  })
})

function streamHarness() {
  const sent: any[] = []
  const socket = Object.assign(new EventEmitter(), { readyState: 0, send: vi.fn((raw: string) => sent.push(JSON.parse(raw))), terminate: vi.fn() })
  const connection = { openStreamSocket: () => { queueMicrotask(() => { socket.readyState = 1; socket.emit('open') }); return socket } } as unknown as DshConnection
  const receive = (value: unknown) => socket.emit('message', Buffer.from(JSON.stringify({ type: 'item', streamId: sent[0].streamId, value })), false)
  return { sent, socket, connection, receive }
}
const address = { kind: 'subagent', parentSessionId: 'root', childSessionId: 'a', mode: 'continuable' } as const
describe('child history observation', () => {
  it('uses the non-activating subagent route and releases its own carrier after the snapshot', async () => {
    const h = streamHarness()
    const result = readChildSnapshot(h.connection, address, signal())
    await Promise.resolve()
    expect(h.sent[0]).toMatchObject({ endpoint: 'session/follow', payload: { args: { request: { address, maxMessages: 60 } } } })
    expect(h.sent[0].payload.args.request).not.toHaveProperty('assistantStream')
    h.receive({ type: 'snapshot', header: { id: 'a' }, cursor: 0, hasMore: false, records: [] })
    expect(await result).toEqual({ childSessionId: 'a', messages: [], truncated: false })
    expect(h.socket.terminate).toHaveBeenCalledOnce()
  })
  it('rejects mismatched child snapshots and closes the observation', async () => {
    const h = streamHarness()
    const result = readChildSnapshot(h.connection, address, signal())
    const rejected = expect(result).rejects.toThrow('invalid subscription frame')
    await Promise.resolve()
    h.receive({ type: 'snapshot', header: { id: 'wrong' }, cursor: 0, hasMore: false, records: [] })
    await rejected
    expect(h.socket.terminate).toHaveBeenCalledOnce()
  })
  it('cancels a pending read immediately', async () => {
    const h = streamHarness(); const abort = new AbortController()
    const result = readChildSnapshot(h.connection, address, abort.signal)
    abort.abort()
    await expect(result).rejects.toThrow('cancelled')
    expect(h.socket.terminate).toHaveBeenCalledOnce()
  })
})
