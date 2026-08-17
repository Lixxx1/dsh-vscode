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

  it('reads the official runtime plugin inventory without inventing a management RPC', async () => {
    const requests: Array<{ method: string; payload: unknown }> = []
    vi.stubGlobal('fetch', vi.fn(async (_url: URL, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as { rpcId: string; method: string; payload: unknown }
      requests.push({ method: request.method, payload: request.payload })
      return new Response(JSON.stringify({
        type: 'server-response',
        rpcId: request.rpcId,
        result: {
          ok: true,
          value: {
            entries: [{
              entryId: 'plugin-1',
              moduleName: '@example/runtime-plugin',
              enabled: true,
              fiberPhase: 'active',
            }],
          },
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }))
    const client = new DshClient(new URL('http://127.0.0.1:31415'))

    await expect(client.pluginInventory()).resolves.toEqual({
      entries: [{
        entryId: 'plugin-1',
        moduleName: '@example/runtime-plugin',
        enabled: true,
        fiberPhase: 'active',
      }],
    })
    expect(requests).toEqual([{ method: 'pluginInventory/list', payload: { args: {} } }])
  })

  it('reads a durable image through its authorizing session', async () => {
    const requests: Array<{ method: string; payload: unknown }> = []
    vi.stubGlobal('fetch', vi.fn(async (_url: URL, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as { rpcId: string; method: string; payload: unknown }
      requests.push({ method: request.method, payload: request.payload })
      return new Response(JSON.stringify({
        type: 'server-response',
        rpcId: request.rpcId,
        result: {
          ok: true,
          value: {
            attachment: {
              attachmentId: 'sha256:image',
              mediaType: 'image/png',
              bytes: 3,
              width: 1,
              height: 1,
            },
            data: 'YWJj',
          },
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }))
    const client = new DshClient(new URL('http://127.0.0.1:31415'))

    await expect(client.attachment('session-1', 'sha256:image')).resolves.toMatchObject({ data: 'YWJj' })
    expect(requests).toEqual([{
      method: 'session.attachment',
      payload: { sessionId: 'session-1', attachmentId: 'sha256:image' },
    }])
  })

  it('describes and mutates official runtime settings with revision protection', async () => {
    const requests: Array<{ method: string; payload: unknown }> = []
    vi.stubGlobal('fetch', vi.fn(async (_url: URL, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as { rpcId: string; method: string; payload: unknown }
      requests.push({ method: request.method, payload: request.payload })
      return new Response(JSON.stringify({
        type: 'server-response',
        rpcId: request.rpcId,
        result: { ok: true, value: request.method === 'settings.describe'
          ? { writable: true, hasDocument: true, namespaces: [] }
          : { ns: 'agent-loop', revision: 4 } },
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }))
    const client = new DshClient(new URL('http://127.0.0.1:31415'))

    await client.settings()
    await client.mutateSettings('agent-loop', [{
      op: 'set', path: ['maxParallelToolCalls'], value: 4,
    }], 3)

    expect(requests).toEqual([
      { method: 'settings.describe', payload: {} },
      {
        method: 'settings.mutate',
        payload: {
          ns: 'agent-loop',
          ops: [{ op: 'set', path: ['maxParallelToolCalls'], value: 4 }],
          expectedRevision: 3,
        },
      },
    ])
  })

  it('requests older history using the official beforeSeq cursor', async () => {
    const requests: Array<{ method: string; payload: unknown }> = []
    vi.stubGlobal('fetch', vi.fn(async (_url: URL, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as { rpcId: string; method: string; payload: unknown }
      requests.push({ method: request.method, payload: request.payload })
      return new Response(JSON.stringify({
        type: 'server-response', rpcId: request.rpcId,
        result: { ok: true, value: { events: [], hasMore: false } },
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }))
    const client = new DshClient(new URL('http://127.0.0.1:31415'))

    await client.history('session-1')
    await client.history('session-1', 42)

    expect(requests).toEqual([
      { method: 'session.history', payload: { sessionId: 'session-1', maxMessages: 100 } },
      { method: 'session.history', payload: { sessionId: 'session-1', beforeSeq: 42, maxMessages: 100 } },
    ])
  })
})
