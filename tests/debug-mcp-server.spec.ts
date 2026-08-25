import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DebugMcpServer, type DebugToolHandler } from '../src/debug-mcp-server.ts'

const servers: DebugMcpServer[] = []

function fakeTools(): DebugToolHandler {
  return {
    start: vi.fn(async () => ({ status: 'selection-required', configurations: ['Launch app'] })),
    breakpoint: vi.fn(async () => ({ breakpoints: [] })),
    control: vi.fn(async () => ({
      sessionId: 'session-1',
      name: 'Launch app',
      type: 'node',
      phase: 'running',
      stopEpoch: 0,
      threads: {},
    })),
    context: vi.fn(async () => ({
      session: {
        sessionId: 'session-1',
        name: 'Launch app',
        type: 'node',
        phase: 'stopped',
        stopEpoch: 1,
        threads: { 1: 'stopped' },
        currentThreadId: 1,
      },
      frames: [],
      scopes: [],
      truncated: false,
    })),
  }
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async server => { await server.dispose() }))
})

describe('debug MCP server', () => {
  it('requires its runtime token and exposes only the four debugger tools', async () => {
    const tools = fakeTools()
    const server = new DebugMcpServer(tools)
    servers.push(server)
    const endpoint = await server.start()

    const unauthorized = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    })
    expect(unauthorized.status).toBe(401)

    const client = new Client({ name: 'debug-test', version: '1.0.0' })
    const transport = new StreamableHTTPClientTransport(endpoint, {
      requestInit: { headers: { Authorization: `Bearer ${server.authorizationToken}` } },
    })
    await client.connect(transport as unknown as Transport)

    const catalog = await client.listTools()
    expect(catalog.tools.map(tool => tool.name)).toEqual([
      'debug_start',
      'debug_breakpoint',
      'debug_control',
      'debug_context',
    ])
    const call = await client.callTool({ name: 'debug_context', arguments: {} })
    const content = call.content[0]
    expect(content?.type).toBe('text')
    if (content?.type !== 'text') throw new Error('Expected a text tool result.')
    expect(JSON.parse(content.text)).toMatchObject({ session: { sessionId: 'session-1', phase: 'stopped' } })
    expect(tools.context).toHaveBeenCalledOnce()

    await client.close()
  })
})
