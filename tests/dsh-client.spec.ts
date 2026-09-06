import { afterEach, describe, expect, it, vi } from 'vitest'
import { DshClient } from '../src/dsh-client.js'

interface RecordedCall {
  url: string
  method: string
  args: Record<string, unknown>
  cookie?: string | null
}

function stubTransport(): RecordedCall[] {
  const calls: RecordedCall[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: URL, init?: RequestInit) => {
    const url = input instanceof URL ? input : new URL(String(input))
    const body = JSON.parse(String(init?.body ?? '{}')) as {
      type?: string
      rpcId?: string
      method?: string
      payload?: { args?: Record<string, unknown> }
    }
    const headers = new Headers(init?.headers)
    const cookie = headers.get('cookie')
    const rpcId = typeof body.rpcId === 'string' ? body.rpcId : 'rpc'
    const method = typeof body.method === 'string' ? body.method : url.pathname.replace(/^\/api\//, '')
    calls.push({ url: url.pathname, method, args: body.payload?.args ?? {}, cookie })
    let value: unknown = { accepted: true }
    if (method === 'session/list') value = { items: [] }
    if (method === 'session/page') value = { records: [], hasMore: false }
    if (method === 'session/rename') value = { title: 'Renamed', seq: 12 }
    if (method === 'workspace/archiveSession') value = { archivedSessionIds: ['archived-1', 'session-1'] }
    if (method === 'session/selectModel') value = { selected: { provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'high' } }
    if (method === 'session/attachment') {
      value = {
        attachment: { attachmentId: 'sha256:image', mediaType: 'image/png', bytes: 3, width: 1, height: 1 },
        data: 'YWJj',
      }
    }
    if (method === 'pluginInventory/list') {
      value = {
        entries: [{ entryId: 'plugin-1', moduleName: '@example/runtime-plugin', enabled: true, fiberPhase: 'active' }],
      }
    }
    if (method === 'settings/describe') value = { writable: true, hasDocument: true, namespaces: [] }
    if (method === 'settings/mutate') value = { ns: 'agent-loop', revision: 4 }
    if (method === 'commands/list') value = [{ name: 'compact', description: 'Compact' }]
    if (method === 'commands/execute') {
      value = { commandId: 'command-1', result: { kind: 'success' } }
    }
    if (method === 'skills/list') value = { skills: [] }
    if (method === 'agentPresets/list') {
      value = { presets: [{ id: 'standard', trust: 'system', isDefault: true, name: '标准模式' }], authorable: true, hasDocument: false }
    }
    if (method === 'session/modelCatalog') {
      value = {
        default: { provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'high' },
        routableProviders: ['deepseek-official'],
        groups: [{ id: 'deepseek-official', name: 'DeepSeek', models: [{ id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash' }] }],
        failures: [],
      }
    }
    return new Response(JSON.stringify({
      type: 'server-response',
      rpcId,
      result: { ok: true, value },
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  }))
  return calls
}

function expectCall(calls: RecordedCall[], index: number): RecordedCall {
  const call = calls[index]
  expect(call, `expected a ${String(index)}th RPC call`).toBeDefined()
  return call!
}

describe('DshClient rc.1 wire protocol', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  it('exchanges the launch token for the session cookie before any RPC', async () => {
    const responses = [
      new Response(null, { status: 303, headers: { 'set-cookie': 'dsh-auth-abc=token-value; Path=/; HttpOnly' } }),
    ]
    const fetched: Array<{ url: string; cookie?: string | null }> = []
    vi.stubGlobal('fetch', vi.fn(async (input: URL, init?: RequestInit) => {
      fetched.push({ url: String(input), cookie: new Headers(init?.headers).get('cookie') })
      const next = responses.shift()
      if (next !== undefined) return next
      const body = JSON.parse(String(init?.body)) as { rpcId: string }
      return new Response(JSON.stringify({
        type: 'server-response',
        rpcId: body.rpcId,
        result: { ok: true, value: { items: [] } },
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }))
    const client = new DshClient(new URL('http://127.0.0.1:31415/?token=launch-token'))

    await client.listSessions()

    expect(fetched[0]?.url).toBe('http://127.0.0.1:31415/?token=launch-token')
    expect(fetched[1]?.url).toBe('http://127.0.0.1:31415/api/session/list')
    expect(fetched[1]?.cookie).toBe('dsh-auth-abc=token-value')
  })

  it('sends direct steering and official queue mutations through their rc.1 endpoints', async () => {
    const calls = stubTransport()
    const client = new DshClient(new URL('http://127.0.0.1:31415'))

    await client.prompt('session-1', 'Change direction', [], 'steer')
    await client.updateQueue('session-1', 'item-1', {
      kind: 'edit',
      content: [{ type: 'text', text: 'Updated follow-up' }],
    })
    await client.updateQueue('session-1', 'item-1', { kind: 'steer' })

    expect(calls).toHaveLength(3)
    expectCall(calls, 0).url = '/api/session/prompt'
    const prompt = calls[0]!
    expect(prompt.method).toBe('session/prompt')
    expect(prompt.args.request).toEqual(expect.objectContaining({
      sessionId: 'session-1',
      mode: 'steer',
      content: [{ type: 'text', text: 'Change direction' }],
    }))
    expect(prompt.args.request).toEqual(expect.objectContaining({
      requestId: expect.any(String),
      clientTimeZone: expect.any(String),
    }))
    expect(calls[1]).toMatchObject({
      url: '/api/session/updateQueue',
      method: 'session/updateQueue',
      args: {
        request: {
          sessionId: 'session-1',
          itemId: 'item-1',
          action: { kind: 'edit', content: [{ type: 'text', text: 'Updated follow-up' }] },
        },
      },
    })
    expect(calls[2]).toMatchObject({
      url: '/api/session/updateQueue',
      method: 'session/updateQueue',
      args: {
        request: {
          sessionId: 'session-1',
          itemId: 'item-1',
          action: { kind: 'steer' },
        },
      },
    })
  })

  it('lists, renames and archives sessions on the rc.1 session/workspace endpoints', async () => {
    const calls = stubTransport()
    const client = new DshClient(new URL('http://127.0.0.1:31415'))

    await expect(client.listWorkspaces()).resolves.toEqual({ archivedSessionIds: [] })
    await expect(client.renameSession('session-1', 'Renamed')).resolves.toMatchObject({ title: 'Renamed' })
    await expect(client.archiveSession('session-1')).resolves.toEqual({ archivedSessionIds: ['archived-1', 'session-1'] })
    await expect(client.listWorkspaces()).resolves.toEqual({ archivedSessionIds: ['archived-1', 'session-1'] })

    expect(calls).toHaveLength(2)
    expect(calls[0]).toMatchObject({
      url: '/api/session/rename',
      method: 'session/rename',
      args: { request: { sessionId: 'session-1', title: 'Renamed' } },
    })
    expect(calls[1]).toMatchObject({
      url: '/api/workspace/archiveSession',
      method: 'workspace/archiveSession',
      args: { request: { sessionId: 'session-1' } },
    })
  })

  it('lists sessions by their rc.1 slash endpoint and promotes the projected agent preset', async () => {
    const calls: RecordedCall[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: URL, init?: RequestInit) => {
      const url = input instanceof URL ? input : new URL(String(input))
      const body = JSON.parse(String(init?.body)) as { rpcId: string; method: string; payload: { args: Record<string, unknown> } }
      calls.push({ url: url.pathname, method: body.method, args: body.payload.args })
      return new Response(JSON.stringify({
        type: 'server-response',
        rpcId: body.rpcId,
        result: {
          ok: true,
          value: {
            items: [{
              sessionId: 'session-1',
              updatedAt: 1,
              running: false,
              blank: true,
              cwd: '/tmp',
              projections: { asOfSeq: 2, values: { agentPreset: 'standard' } },
            }],
          },
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }))
    const client = new DshClient(new URL('http://127.0.0.1:31415'))

    const { items } = await client.listSessions()
    expect(calls[0]).toMatchObject({ url: '/api/session/list', method: 'session/list', args: { _request: {} } })
    expect(items[0]).toMatchObject({ sessionId: 'session-1', agentPreset: 'standard' })
  })

  it('reads the official runtime plugin inventory on its rc.1 endpoint', async () => {
    const calls = stubTransport()
    const client = new DshClient(new URL('http://127.0.0.1:31415'))

    await expect(client.pluginInventory()).resolves.toEqual({
      entries: [{
        entryId: 'plugin-1',
        moduleName: '@example/runtime-plugin',
        enabled: true,
        fiberPhase: 'active',
      }],
    })
    expect(calls[0]).toMatchObject({ url: '/api/pluginInventory/list', method: 'pluginInventory/list', args: {} })
  })

  it('reads a durable image through its authorizing session', async () => {
    const calls = stubTransport()
    const client = new DshClient(new URL('http://127.0.0.1:31415'))

    await expect(client.attachment('session-1', 'sha256:image')).resolves.toMatchObject({ data: 'YWJj' })
    expect(calls[0]).toMatchObject({
      url: '/api/session/attachment',
      method: 'session/attachment',
      args: { request: { sessionId: 'session-1', attachmentId: 'sha256:image' } },
    })
  })

  it('describes and mutates official runtime settings with revision protection', async () => {
    const calls = stubTransport()
    const client = new DshClient(new URL('http://127.0.0.1:31415'))

    await client.settings()
    await client.mutateSettings('agent-loop', [{
      op: 'set', path: ['maxParallelToolCalls'], value: 4,
    }], 3)

    expect(calls[0]).toMatchObject({ url: '/api/settings/describe', method: 'settings/describe', args: {} })
    expect(calls[1]).toMatchObject({
      url: '/api/settings/mutate',
      method: 'settings/mutate',
      args: {
        ns: 'agent-loop',
        ops: [{ op: 'set', path: ['maxParallelToolCalls'], value: 4 }],
        expectedRevision: 3,
      },
    })
  })

  it('requests history pages from the rc.1 session/page endpoint with a bounded cursor', async () => {
    const calls: RecordedCall[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: URL, init?: RequestInit) => {
      const url = input instanceof URL ? input : new URL(String(input))
      const body = JSON.parse(String(init?.body)) as { rpcId: string; method: string }
      calls.push({ url: url.pathname, method: body.method, args: (JSON.parse(String(init?.body)) as { payload: { args: Record<string, unknown> } }).payload.args })
      const value = body.method === 'session/list'
        ? { items: [{ sessionId: 'session-1', updatedAt: 1, running: false, blank: false, cwd: '/tmp', projections: { asOfSeq: 101 } }] }
        : { records: [{ type: 'event', event: { type: 'assistant/message', seq: 100 } }], hasMore: true }
      return new Response(JSON.stringify({
        type: 'server-response',
        rpcId: body.rpcId,
        result: { ok: true, value },
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }))
    const client = new DshClient(new URL('http://127.0.0.1:31415'))

    const tail = await client.history('session-1')
    const older = await client.history('session-1', 42)

    expect(tail.hasMore).toBe(true)
    expect(tail.events[0]?.event).toMatchObject({ type: 'assistant/message', seq: 100 })
    expect(older.hasMore).toBe(true)
    expect(calls).toHaveLength(3)
    expect(calls[0]).toMatchObject({ url: '/api/session/list', method: 'session/list', args: { _request: {} } })
    expect(calls[1]).toMatchObject({
      url: '/api/session/page',
      method: 'session/page',
      args: { request: { address: { kind: 'session', sessionId: 'session-1' }, throughSeq: 100, maxMessages: 100 } },
    })
    expect(calls[2]).toMatchObject({
      url: '/api/session/page',
      method: 'session/page',
      args: { request: { address: { kind: 'session', sessionId: 'session-1' }, throughSeq: 41, maxMessages: 100 } },
    })
  })

  it('uses the rc.1 command image envelope and always sends the images array', async () => {
    const calls = stubTransport()
    const client = new DshClient(new URL('http://127.0.0.1:31415'))

    await client.executeCommand('session-1', '/compact')
    await client.executeCommand('session-1', '/plan inspect this', [{
      type: 'image',
      mediaType: 'image/png',
      data: 'YWJj',
      name: 'diagram.png',
    }])

    expect(calls[0]).toMatchObject({
      url: '/api/commands/execute',
      method: 'commands/execute',
      args: { agentId: 'session-1', line: '/compact', images: [] },
    })
    expect(calls[1]).toMatchObject({
      url: '/api/commands/execute',
      method: 'commands/execute',
      args: {
        agentId: 'session-1',
        line: '/plan inspect this',
        images: [{ mediaType: 'image/png', data: 'YWJj', name: 'diagram.png' }],
      },
    })
  })
})
