import { createHash } from 'node:crypto'
import { createServer, type RequestListener, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { once } from 'node:events'
import { WebSocketServer } from 'ws'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DshConnection, dshLocalUrl } from '../src/dsh-connection.ts'
import { DshRemoteApi } from '../src/dsh-remote-api.ts'

const servers: Server[] = []
const connections: DshConnection[] = []
const socketServers: WebSocketServer[] = []
const TOKEN = 'launch-token-for-test'
const COOKIE_VALUE = 'v1.eyJ0ZXN0Ijp0cnVlfQ.c2lnbmF0dXJl'

function cookieFor(authority: string): string {
  return `dsh-auth-${createHash('sha256').update(authority).digest('base64url')}=${COOKIE_VALUE}`
}

async function serve(handler: RequestListener): Promise<URL> {
  const server = createServer(handler)
  servers.push(server)
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  return new URL(`http://127.0.0.1:${String((server.address() as AddressInfo).port)}`)
}

function connect(url: URL): DshConnection {
  const connection = new DshConnection(url)
  connections.push(connection)
  return connection
}

function launchUrl(url: URL): URL { return new URL(`/?token=${TOKEN}`, url) }

afterEach(async () => {
  vi.unstubAllGlobals()
  for (const connection of connections.splice(0)) connection.dispose()
  await Promise.all(socketServers.splice(0).map(server => new Promise<void>(resolve => {
    for (const client of server.clients) client.terminate()
    server.close(() => { resolve() })
  })))
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => {
    server.closeAllConnections()
    server.close(() => { resolve() })
  })))
})

describe('DSH authenticated Remote connection', () => {
  it('renews a refused cookie only on explicit reconnect without replaying a mutation', async () => {
    let authentications = 0
    let mutations = 0
    let failAuthentication = false
    const url = await serve((request, response) => {
      if (request.method === 'GET') {
        authentications++
        if (failAuthentication) response.writeHead(503)
        else response.writeHead(303, { location: '/', 'set-cookie': cookieFor(request.headers.host!) })
      } else { mutations++; response.writeHead(401) }
      response.end()
    })
    const connection = connect(url)
    expect(connection.canReauthenticate).toBe(false)
    await connection.authenticate(launchUrl(url))
    expect(connection.canReauthenticate).toBe(true)
    await expect(new DshRemoteApi(connection).prompt('s', 'One task')).rejects.toMatchObject({ code: 'authentication-required' })
    expect(connection.authenticated).toBe(false)
    expect(connection.canReauthenticate).toBe(true)
    expect(authentications).toBe(1)
    failAuthentication = true
    await expect(connection.reauthenticate()).rejects.toMatchObject({ code: 'authentication-failed' })
    expect(connection.authenticated).toBe(false)
    expect(connection.canReauthenticate).toBe(true)
    failAuthentication = false
    await connection.reauthenticate()
    expect(connection.authenticated).toBe(true)
    expect(connection.canReauthenticate).toBe(true)
    expect(authentications).toBe(3)
    expect(mutations).toBe(1)
    await connection.reauthenticate()
    expect(authentications).toBe(3)
    expect(JSON.stringify(connection)).not.toContain(TOKEN)
    expect(JSON.stringify(connection)).not.toContain(COOKIE_VALUE)
    const noToken = connect(url)
    expect(noToken.canReauthenticate).toBe(false)
    await expect(noToken.reauthenticate()).rejects.toMatchObject({ code: 'authentication-required' })
    expect(authentications).toBe(3)
    connection.dispose()
    expect(connection.canReauthenticate).toBe(false)
  })

  it('invalidates a cookie refused by the WebSocket upgrade and permits explicit reauthentication', async () => {
    const url = await serve((request, response) => {
      if (request.url?.includes('token=')) response.writeHead(303, { location: '/', 'set-cookie': cookieFor(request.headers.host!) })
      else response.writeHead(401)
      response.end()
    })
    const connection = connect(url)
    await connection.authenticate(launchUrl(url))
    const socket = connection.openStreamSocket()
    const failed = once(socket, 'error')
    await failed
    expect(connection.authenticated).toBe(false)
    expect(connection.canReauthenticate).toBe(true)
    await connection.reauthenticate()
    expect(connection.authenticated).toBe(true)
  })

  it('exchanges the root token, sends named RPC arguments, and authenticates the multiplexed WebSocket', async () => {
    const requests: Array<{ path: string; cookie: string | undefined; body: any }> = []
    const url = await serve((request, response) => {
      if (request.method === 'GET') {
        expect(request.url).toBe(`/?token=${TOKEN}`)
        expect(request.headers.cookie).toBeUndefined()
        response.writeHead(303, { location: '/', 'set-cookie': `${cookieFor(request.headers.host!)}; Path=/; HttpOnly; SameSite=Strict` })
        response.end()
        return
      }
      let body = ''
      request.on('data', chunk => { body += chunk })
      request.on('end', () => {
        const message = JSON.parse(body)
        requests.push({ path: request.url!, cookie: request.headers.cookie, body: message })
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify({
          type: 'server-response', rpcId: message.rpcId,
          result: { ok: true, value: message.method === 'session/list' ? { items: [] } : { accepted: true } },
        }))
      })
    })
    const connection = connect(url)
    await connection.authenticate(launchUrl(url))
    expect(connection.authenticated).toBe(true)
    expect(connection.baseUrl.search).toBe('')
    expect(JSON.stringify(connection)).not.toContain(TOKEN)
    expect(JSON.stringify(connection)).not.toContain(COOKIE_VALUE)

    const api = new DshRemoteApi(connection)
    await expect(api.listSessions()).resolves.toEqual({ items: [] })
    await expect(api.prompt('session-1', 'hello')).resolves.toEqual({ accepted: true })
    await expect(api.cancel('session-1')).resolves.toEqual({ accepted: true })
    expect(requests.map(request => request.path)).toEqual(['/api/session/list', '/api/session/prompt', '/api/session/cancel'])
    expect(requests.every(request => request.cookie === cookieFor(url.host))).toBe(true)
    expect(requests[0]!.body).toEqual({ type: 'client-request', rpcId: expect.any(String), method: 'session/list', payload: { args: { _request: {} } } })
    expect(requests[1]!.body.payload.args.request.requestId).toEqual(expect.any(String))
    expect(requests[1]!.body.payload.args.request.requestId).not.toBe(requests[1]!.body.rpcId)

    let upgradePath: string | undefined
    let upgradeCookie: string | undefined
    const socketServer = new WebSocketServer({ server: servers[0] })
    socketServers.push(socketServer)
    socketServer.on('connection', (_socket, request) => {
      upgradePath = request.url
      upgradeCookie = request.headers.cookie
    })
    const socket = connection.openStreamSocket()
    await once(socket, 'open')
    expect(upgradePath).toBe('/api/remote.mux')
    expect(upgradeCookie).toBe(cookieFor(url.host))
    const closed = once(socket, 'close')
    connection.dispose()
    await closed
    expect(connection.authenticated).toBe(false)
    expect(connection.browserUrl().search).toBe('')
  })

  it.each([
    'https://127.0.0.1:3080/', 'http://example.com:3080/', 'http://localhost:3080/',
    'http://user:password@127.0.0.1:3080/', 'http://127.0.0.1:3080/other',
    'http://127.0.0.1:3080/?token=a&token=b', 'http://127.0.0.1:3080/?token=',
    'http://127.0.0.1:3080/?other=value', 'http://127.0.0.1:3080/#token=a',
    'http://127.0.0.1:0/',
  ])('rejects unsafe or ambiguous launch endpoints: %s', value => {
    expect(() => dshLocalUrl(new URL(value))).toThrow()
  })

  it('does not send the token to a different authority', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const connection = connect(new URL('http://127.0.0.1:3080'))
    await expect(connection.authenticate(new URL(`http://127.0.0.1:3081/?token=${TOKEN}`))).rejects.toMatchObject({ code: 'authentication-required' })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('never follows an authentication redirect or sends credentials to its target', async () => {
    let hits = 0
    const target = await serve((_request, response) => { hits++; response.end('unexpected') })
    const source = await serve((request, response) => {
      response.writeHead(303, { location: target.href, 'set-cookie': cookieFor(request.headers.host!) })
      response.end()
    })
    await expect(connect(source).authenticate(launchUrl(source))).rejects.toMatchObject({ code: 'authentication-failed' })
    expect(hits).toBe(0)
  })

  it.each(['wrong-authority', 'missing', 'duplicate', 'invalid'])('rejects a %s cookie', async kind => {
    const url = await serve((request, response) => {
      const good = cookieFor(request.headers.host!)
      response.writeHead(303, {
        location: '/',
        ...(kind === 'missing' ? {} : { 'set-cookie': kind === 'duplicate' ? [good, good]
          : kind === 'wrong-authority' ? cookieFor('127.0.0.1:1') : good.replace(COOKIE_VALUE, 'garbage') }),
      })
      response.end()
    })
    const connection = connect(url)
    await expect(connection.authenticate(launchUrl(url))).rejects.toMatchObject({ code: 'authentication-failed' })
    expect(connection.authenticated).toBe(false)
  })

  it('does not expose a launch URL from native authentication errors', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error(`failed at /?token=${TOKEN}`) }))
    const url = new URL('http://127.0.0.1:3080')
    await expect(connect(url).authenticate(launchUrl(url))).rejects.toThrow('Could not authenticate with DSH')
  })

  it('discards late authentication responses after disposal', async () => {
    let complete!: (response: Response) => void
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => { complete = resolve })))
    const url = new URL('http://127.0.0.1:3080')
    const connection = connect(url)
    const pending = connection.authenticate(launchUrl(url))
    connection.dispose()
    complete(new Response(null, { status: 303, headers: { location: '/', 'set-cookie': cookieFor(url.host) } }))
    await expect(pending).rejects.toThrow()
    expect(connection.authenticated).toBe(false)
    expect(connection.browserUrl().search).toBe('')
  })

  it.each([
    null, { type: 'server-response', rpcId: 'wrong', result: { ok: true, value: {} } },
    { type: 'server-response', result: null },
  ])('rejects a malformed response without echoing its body', async body => {
    const url = await serve((_request, response) => { response.end(JSON.stringify(body)) })
    await expect(connect(url).call('session/list', { _request: {} })).rejects.toMatchObject({ code: 'invalid-response' })
  })

  it('preserves Remote error codes and redacts known credentials in their messages', async () => {
    const url = await serve((request, response) => {
      if (request.method === 'GET') {
        response.writeHead(303, { location: '/', 'set-cookie': cookieFor(request.headers.host!) })
        response.end()
        return
      }
      let body = ''
      request.on('data', chunk => { body += chunk })
      request.on('end', () => {
        response.end(JSON.stringify({ type: 'server-response', rpcId: JSON.parse(body).rpcId,
          result: { ok: false, error: { code: 'session/model-unavailable', message: `Rejected ${TOKEN} and ${COOKIE_VALUE}`, details: {} } },
        }))
      })
    })
    const connection = connect(url)
    await connection.authenticate(launchUrl(url))
    await expect(connection.call('session/prompt', {})).rejects.toMatchObject({
      code: 'session/model-unavailable', message: 'Rejected [redacted] and [redacted]',
    })
  })

  it('does not replay a POST when its response is lost', async () => {
    let calls = 0
    const url = await serve(request => {
      request.resume()
      request.once('end', () => { calls++; request.socket.destroy() })
    })
    await expect(new DshRemoteApi(connect(url)).prompt('session-1', 'hello')).rejects.toMatchObject({ code: 'transport-error' })
    expect(calls).toBe(1)
  })

  it('does not follow RPC redirects, retry, or include the response body in an error', async () => {
    let calls = 0
    const url = await serve((_request, response) => {
      calls++
      response.writeHead(307, { location: '/unexpected' })
      response.end(`/?token=${TOKEN}`)
    })
    await expect(connect(url).call('session/list', {})).rejects.toMatchObject({ code: 'http-error', status: 307 })
    expect(calls).toBe(1)
  })

  it('never forwards its WebSocket cookie through a redirect', async () => {
    let targetHits = 0
    const target = await serve((_request, response) => { targetHits++; response.end() })
    const source = await serve((request, response) => {
      response.writeHead(303, { location: '/', 'set-cookie': cookieFor(request.headers.host!) })
      response.end()
    })
    servers.at(-1)!.on('upgrade', (_request, socket) => {
      socket.end(`HTTP/1.1 302 Found\r\nLocation: ${target.href.replace('http:', 'ws:')}\r\nContent-Length: 0\r\n\r\n`)
    })
    const connection = connect(source)
    await connection.authenticate(launchUrl(source))
    const socket = connection.openStreamSocket()
    const closed = new Promise<void>(resolve => { socket.once('close', () => { resolve() }) })
    const [error] = await once(socket, 'error')
    await closed
    expect(error.message).toContain('302')
    expect(targetHits).toBe(0)
  })

  it('rejects non-JSON responses as invalid protocol rather than an unavailable server', async () => {
    const url = await serve((_request, response) => { response.end('<html>not DSH</html>') })
    await expect(connect(url).call('session/list', {})).rejects.toMatchObject({ code: 'invalid-response' })
  })

  it.each(['../escape', 'session/list?token=secret', 'http://127.0.0.1:3090/', 'session.list'])('rejects invalid endpoint %s before sending', async endpoint => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    await expect(connect(new URL('http://127.0.0.1:3080')).call(endpoint, {})).rejects.toMatchObject({ code: 'invalid-endpoint' })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('classifies expired authentication without exposing the response body', async () => {
    const url = await serve((_request, response) => { response.writeHead(401); response.end(TOKEN) })
    await expect(connect(url).call('session/list', {})).rejects.toMatchObject({ code: 'authentication-required', status: 401 })
  })

  it('aborts in-flight RPC calls on disposal', async () => {
    let received!: () => void
    const arrived = new Promise<void>(resolve => { received = resolve })
    const url = await serve(request => { request.resume(); received() })
    const connection = connect(url)
    const pending = connection.call('session/list', {})
    const checked = expect(pending).rejects.toMatchObject({ code: 'cancelled' })
    await arrived
    connection.dispose()
    await checked
  })
})
