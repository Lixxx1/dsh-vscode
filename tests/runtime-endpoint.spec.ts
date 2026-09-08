import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { assertSupportedDshVersion, probeDshServer, shouldProbeExistingDsh } from '../src/runtime-endpoint.ts'
import { DshConnection } from '../src/dsh-connection.ts'

const servers: Server[] = []

async function serve(responseFor: (body: Record<string, unknown>) => unknown): Promise<URL> {
  const server = createServer((request, response) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', chunk => { body += chunk })
    request.on('end', () => {
      const payload = JSON.parse(body) as Record<string, unknown>
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify(responseFor(payload)))
    })
  })
  servers.push(server)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address() as AddressInfo
  return new URL(`http://127.0.0.1:${String(address.port)}`)
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => {
    server.close(error => { if (error === undefined) resolve(); else reject(error) })
  })))
})

describe('existing DSH runtime probe', () => {
  it('runs only for the default unmanaged launch configuration', () => {
    expect(shouldProbeExistingDsh(true, '', false)).toBe(true)
    expect(shouldProbeExistingDsh(false, '', false)).toBe(false)
    expect(shouldProbeExistingDsh(true, '/opt/custom-dsh', false)).toBe(false)
    expect(shouldProbeExistingDsh(true, '', true)).toBe(false)
  })

  it('accepts a matching official session/list response', async () => {
    const url = await serve(request => ({
      type: 'server-response',
      rpcId: request.rpcId,
      result: { ok: true, value: { items: [] } },
    }))

    await expect(probeDshServer(new DshConnection(url))).resolves.toEqual({ kind: 'ready' })
  })

  it('rejects a service that does not speak the DSH RPC protocol', async () => {
    const url = await serve(() => ({ status: 'ok' }))

    await expect(probeDshServer(new DshConnection(url))).resolves.toEqual({ kind: 'invalid-response' })
  })

  it('rejects a response that does not echo the request id', async () => {
    const url = await serve(() => ({
      type: 'server-response',
      rpcId: 'some-other-request',
      result: { ok: true, value: { items: [] } },
    }))

    await expect(probeDshServer(new DshConnection(url))).resolves.toEqual({ kind: 'invalid-response' })
  })

  it.each([401, 403, 404])('distinguishes HTTP %s from a stopped server', async status => {
    const server = createServer((request, response) => { request.resume(); response.writeHead(status); response.end() })
    servers.push(server)
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
    const url = new URL(`http://127.0.0.1:${String((server.address() as AddressInfo).port)}`)
    await expect(probeDshServer(new DshConnection(url))).resolves.toEqual({
      kind: status === 404 ? 'unsupported' : 'authentication-required',
    })
  })

  it('recognizes a service that disappeared', async () => {
    const url = await serve(() => ({}))
    const server = servers.pop()!
    await new Promise<void>(resolve => { server.close(() => { resolve() }) })
    await expect(probeDshServer(new DshConnection(url))).resolves.toEqual({ kind: 'unavailable' })
  })

  it.each(['0.1.1-rc.2', '0.1.0-rc.8', '0.1.2-alpha.5', '0.1.2-rc.0', '0.0.9'])('rejects the unsupported runtime %s early', version => {
    expect(() => assertSupportedDshVersion(version)).toThrow('0.1.2-rc.1')
  })

  it.each(['0.1.2-rc.1', 'dsh 0.1.2-rc.2', 'v0.1.2', '0.1.2+build.1', '0.1.3', '0.2.0', '1.0.0', undefined, 'source'])('allows %s to reach the protocol check', version => {
    expect(() => assertSupportedDshVersion(version)).not.toThrow()
  })
})
