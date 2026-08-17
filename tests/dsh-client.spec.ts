import { afterEach, describe, expect, it, vi } from 'vitest'
import { DshClient } from '../src/dsh-client.js'

describe('DshClient queue protocol', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  it('sends direct steering and official queue mutations through their real RPC methods', async () => {
    const requests: Array<{ method: string; payload: unknown }> = []
    vi.stubGlobal('fetch', vi.fn(async (_url: URL, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as { rpcId: string; method: string; payload: unknown }
      requests.push({ method: request.method, payload: request.payload })
      return new Response(JSON.stringify({
        type: 'server-response',
        rpcId: request.rpcId,
        result: { ok: true, value: { accepted: true } },
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }))
    const client = new DshClient(new URL('http://127.0.0.1:31415'))

    await client.prompt('session-1', 'Change direction', [], 'steer')
    await client.updateQueue('session-1', 'item-1', {
      kind: 'edit',
      content: [{ type: 'text', text: 'Updated follow-up' }],
    })
    await client.updateQueue('session-1', 'item-1', { kind: 'steer' })

    expect(requests).toEqual([
      {
        method: 'session.prompt',
        payload: expect.objectContaining({
          sessionId: 'session-1',
          mode: 'steer',
          content: [{ type: 'text', text: 'Change direction' }],
        }),
      },
      {
        method: 'session.updateQueue',
        payload: {
          sessionId: 'session-1',
          itemId: 'item-1',
          action: { kind: 'edit', content: [{ type: 'text', text: 'Updated follow-up' }] },
        },
      },
      {
        method: 'session.updateQueue',
        payload: { sessionId: 'session-1', itemId: 'item-1', action: { kind: 'steer' } },
      },
    ])
  })
})
