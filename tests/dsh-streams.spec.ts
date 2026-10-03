import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import type { DshConnection } from '../src/dsh-connection.js'
import { DshStreams } from '../src/dsh-streams.js'

function harness() {
  const socket = Object.assign(new EventEmitter(), { readyState: 1, send: vi.fn(), terminate: vi.fn() })
  const fatal = vi.fn()
  const streams = new DshStreams({ openStreamSocket: () => socket } as unknown as DshConnection, fatal)
  const core = vi.fn(), failed = vi.fn(), optionalFailed = vi.fn()
  streams.open('session/control', {}, core, failed)
  socket.emit('open')
  streams.open('job/list', {}, () => { throw new Error('invalid rows') }, optionalFailed, false)
  const [control, job] = socket.send.mock.calls.map(([raw]) => JSON.parse(raw).streamId as string)
  const receive = (frame: unknown) => socket.emit('message', Buffer.from(JSON.stringify(frame)), false)
  return { socket, streams, fatal, core, failed, optionalFailed, control, job, receive }
}

describe('independent Remote subscriptions', () => {
  it.each(['end', 'error', 'item'])('isolates an optional stream %s and ignores its late frames', type => {
    const h = harness()
    h.receive({ type, streamId: h.job, value: {}, error: { message: 'secret' } })
    expect(h.optionalFailed).toHaveBeenCalledOnce()
    expect(String(h.optionalFailed.mock.calls[0]?.[0])).not.toContain('secret')
    expect(h.socket.terminate).not.toHaveBeenCalled()
    expect(h.fatal).not.toHaveBeenCalled()
    h.receive({ type: 'item', streamId: h.job, value: {} })
    expect(h.optionalFailed).toHaveBeenCalledOnce()
    h.receive({ type: 'item', streamId: h.control, value: { type: 'baseline' } })
    expect(h.core).toHaveBeenCalledWith({ type: 'baseline' })
    h.streams.dispose()
  })

  it.each(['end', 'error', 'invalid-envelope'])('still fails closed for core or carrier failure: %s', type => {
    const h = harness()
    h.receive(type === 'invalid-envelope' ? {} : { type, streamId: h.control })
    expect(h.fatal).toHaveBeenCalledOnce()
    expect(h.failed).toHaveBeenCalledOnce()
    expect(h.optionalFailed).toHaveBeenCalledOnce()
    expect(h.socket.terminate).toHaveBeenCalledOnce()
  })
})
