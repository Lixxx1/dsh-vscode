import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'
import type {
  DebugBreakpointInput,
  DebugBreakpointResult,
  DebugContextResult,
  DebugControlInput,
  DebugStartInput,
  DebugStartResult,
} from './debug-tools.js'
import type { DebugSessionSnapshot } from './debug-session-manager.js'

const MAX_REQUEST_BYTES = 256 * 1024

export interface DebugToolHandler {
  start(input?: DebugStartInput): Promise<DebugStartResult>
  breakpoint(input: DebugBreakpointInput): Promise<DebugBreakpointResult>
  control(input: DebugControlInput): Promise<DebugSessionSnapshot>
  context(): Promise<DebugContextResult>
}

export interface DebugMcpLogger {
  appendLine(value: string): void
}

function textResult(value: unknown): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text', text: JSON.stringify(value) }] }
}

function tokenMatches(header: string | undefined, token: string): boolean {
  if (header === undefined || !header.startsWith('Bearer ')) return false
  const candidate = Buffer.from(header.slice('Bearer '.length))
  const expected = Buffer.from(token)
  return candidate.length === expected.length && timingSafeEqual(candidate, expected)
}

async function requestBody(request: IncomingMessage): Promise<unknown> {
  const declaredLength = Number(request.headers['content-length'] ?? 0)
  if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BYTES) throw new Error('MCP request body is too large.')
  const chunks: Buffer[] = []
  let length = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
    length += buffer.length
    if (length > MAX_REQUEST_BYTES) throw new Error('MCP request body is too large.')
    chunks.push(buffer)
  }
  if (chunks.length === 0) return undefined
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
}

function closeHttpServer(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve()
  return new Promise(resolve => {
    server.close(() => { resolve() })
    server.closeAllConnections()
  })
}

/** Authenticated, loopback-only MCP endpoint for one managed DSH runtime. */
export class DebugMcpServer implements AsyncDisposable {
  private readonly token = randomBytes(32).toString('base64url')
  private readonly mcp = new McpServer({ name: 'dsh-vscode-debug', version: '1.0.0' })
  private readonly http: Server
  private transport: StreamableHTTPServerTransport | undefined
  private endpointValue: URL | undefined
  private disposed = false

  constructor(
    private readonly tools: DebugToolHandler,
    private readonly logger?: DebugMcpLogger,
  ) {
    this.registerTools()
    this.http = createServer((request, response) => {
      void this.handleRequest(request, response)
    })
  }

  get authorizationToken(): string {
    return this.token
  }

  get endpoint(): URL {
    if (this.endpointValue === undefined) throw new Error('The debug MCP server has not started.')
    return this.endpointValue
  }

  async start(): Promise<URL> {
    if (this.endpointValue !== undefined) return this.endpointValue
    if (this.disposed) throw new Error('The debug MCP server has been disposed.')

    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        this.http.off('listening', onListening)
        reject(error)
      }
      const onListening = (): void => {
        this.http.off('error', onError)
        resolve()
      }
      this.http.once('error', onError)
      this.http.once('listening', onListening)
      this.http.listen(0, '127.0.0.1')
    })
    const address = this.http.address() as AddressInfo
    const host = `127.0.0.1:${String(address.port)}`
    this.transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: randomUUID,
      enableJsonResponse: true,
      allowedHosts: [host],
      enableDnsRebindingProtection: true,
    })
    // SDK v1's Transport callbacks predate exactOptionalPropertyTypes and are
    // structurally compatible at runtime despite the narrower declaration.
    await this.mcp.connect(this.transport as unknown as Transport)
    this.endpointValue = new URL(`http://${host}/mcp`)
    this.logger?.appendLine(`[debug] MCP bridge listening on ${this.endpointValue.href}`)
    return this.endpointValue
  }

  private registerTools(): void {
    this.mcp.registerTool('debug_start', {
      description: 'Start the current VS Code project under its existing launch.json debugger. Use this autonomously when a bug depends on runtime state, a value becomes wrong before the failure, or execution hangs. If multiple configurations are returned, call again with one configuration name.',
      inputSchema: {
        configuration: z.string().trim().min(1).optional().describe('Existing launch.json configuration name. Omit when the workspace has exactly one configuration.'),
      },
    }, async input => textResult(await this.tools.start(input)))

    this.mcp.registerTool('debug_breakpoint', {
      description: 'Add, remove, or list VS Code source breakpoints owned by this debugging session. Lines are 1-based. Set a breakpoint before debug_start when you know where an incorrect value is produced.',
      inputSchema: {
        action: z.enum(['add', 'remove', 'list']),
        path: z.string().trim().min(1).optional().describe('Workspace-relative source file path for add.'),
        line: z.number().int().positive().optional().describe('1-based source line for add.'),
        breakpointId: z.string().trim().min(1).optional().describe('Bridge-owned breakpoint ID for remove.'),
      },
    }, async input => textResult(await this.tools.breakpoint(input)))

    this.mcp.registerTool('debug_control', {
      description: 'Control the DeepSeek-owned VS Code debug session. Continue or step only while paused; use pause for a running or hung program, and stop when the investigation is complete. A running result after an action means execution has not reached another stop yet.',
      inputSchema: {
        action: z.enum(['continue', 'pause', 'next', 'stepIn', 'stepOut', 'stop']),
      },
    }, async input => textResult(await this.tools.control(input)))

    this.mcp.registerTool('debug_context', {
      description: 'Read the current paused VS Code debugger context: stop reason, source location, compact stack, and bounded local variables. Call after a breakpoint, pause, or step before deciding how to edit the code.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    }, async () => textResult(await this.tools.context()))
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      if (this.transport === undefined || this.endpointValue === undefined) throw new Error('Debug MCP bridge is not ready.')
      const requestUrl = new URL(request.url ?? '/', this.endpointValue)
      if (requestUrl.pathname !== '/mcp') {
        response.writeHead(404).end('Not found')
        return
      }
      if (request.headers.host !== this.endpointValue.host) {
        response.writeHead(403).end('Invalid host')
        return
      }
      const authorization = Array.isArray(request.headers.authorization)
        ? request.headers.authorization[0]
        : request.headers.authorization
      if (!tokenMatches(authorization, this.token)) {
        response.writeHead(401, { 'www-authenticate': 'Bearer' }).end('Unauthorized')
        return
      }
      const parsedBody = request.method === 'POST' ? await requestBody(request) : undefined
      await this.transport.handleRequest(request, response, parsedBody)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.logger?.appendLine(`[debug] MCP request failed: ${message}`)
      if (!response.headersSent) {
        response.writeHead(message.includes('too large') ? 413 : 500, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message }, id: null }))
      } else if (!response.writableEnded) {
        response.end()
      }
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.endpointValue = undefined
    await closeHttpServer(this.http)
    await this.mcp.close()
    this.transport = undefined
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.dispose()
  }
}
