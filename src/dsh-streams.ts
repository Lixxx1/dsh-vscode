import { randomUUID } from 'node:crypto'
import WebSocket from 'ws'
import type { DshConnection } from './dsh-connection.js'

export function wireRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

interface Stream {
  endpoint: string
  args: Record<string, unknown>
  item: (value: unknown) => void
  fail: (error: Error) => void
}

/** One authenticated carrier; logical subscriptions have independent lifetimes. */
export class DshStreams {
  private socket: WebSocket | undefined
  private readonly streams = new Map<string, Stream>()
  private closed = false

  constructor(private readonly connection: DshConnection, private readonly failed: (error: Error) => void) {}

  open(endpoint: string, args: Record<string, unknown>, item: Stream['item'], fail: Stream['fail']): () => void {
    if (this.closed) {
      fail(new Error('The DSH event stream is closed. Reconnect the runtime.'))
      return () => {}
    }
    const id = randomUUID()
    const stream = { endpoint, args, item, fail }
    this.streams.set(id, stream)
    try {
      if (this.socket === undefined) this.connect()
      else if (this.socket.readyState === WebSocket.OPEN) this.sendOpen(id, stream)
    } catch {
      this.abort(new Error('Could not open the DSH event stream.'))
    }
    return () => {
      if (!this.streams.delete(id)) return
      if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify({ type: 'cancel', streamId: id }))
    }
  }

  dispose(): void {
    this.abort(new Error('The DSH event stream was disposed.'), false)
  }

  private connect(): void {
    const socket = this.connection.openStreamSocket()
    this.socket = socket
    socket.once('open', () => {
      for (const [id, stream] of this.streams) this.sendOpen(id, stream)
    })
    socket.on('message', (data, binary) => {
      if (this.closed) return
      try {
        if (binary) throw new Error('Binary event frame')
        const frame: unknown = JSON.parse(data.toString())
        if (!wireRecord(frame) || typeof frame.streamId !== 'string') throw new Error('Invalid envelope')
        const stream = this.streams.get(frame.streamId)
        // Cancellation can race an already queued server frame.
        if (stream === undefined) return
        if (frame.type === 'item') stream.item(frame.value)
        else if (frame.type === 'end' || frame.type === 'error') {
          this.streams.delete(frame.streamId)
          // Do not put arbitrary remote error text (or credentials) in logs.
          const error = new Error(`DSH ${stream.endpoint} subscription ended. Reconnect the runtime.`)
          stream.fail(error)
          this.abort(error)
        } else throw new Error('Unknown envelope')
      } catch {
        this.abort(new Error('DSH sent an invalid event stream frame. Reconnect the runtime.'))
      }
    })
    socket.once('error', () => { this.abort(new Error('The DSH event stream connection failed.')) })
    socket.once('close', () => { this.abort(new Error('The DSH event stream connection closed.')) })
  }

  private sendOpen(id: string, stream: Stream): void {
    this.socket?.send(JSON.stringify({ type: 'open', streamId: id, endpoint: stream.endpoint, payload: { args: stream.args } }))
  }

  private abort(error: Error, report = true): void {
    if (this.closed) return
    this.closed = true
    const pending = [...this.streams.values()]
    this.streams.clear()
    this.socket?.terminate()
    for (const stream of pending) stream.fail(error)
    if (report) this.failed(error)
  }
}
