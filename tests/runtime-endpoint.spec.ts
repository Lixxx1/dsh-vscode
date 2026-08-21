import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { probeDshServer, shouldProbeExistingDsh } from '../src/runtime-endpoint.ts'

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

  it('accepts a matching official session.list response', async () => {
    const url = await serve(request => ({
      type: 'server-response',
      rpcId: request.rpcId,
      result: { ok: true, value: { items: [] } },
    }))

    await expect(probeDshServer(url)).resolves.toBe(true)
  })

  it('rejects a service that does not speak the DSH RPC protocol', async () => {
    const url = await serve(() => ({ status: 'ok' }))

    await expect(probeDshServer(url)).resolves.toBe(false)
  })

  it('rejects a response that does not echo the request id', async () => {
    const url = await serve(() => ({
      type: 'server-response',
      rpcId: 'some-other-request',
      result: { ok: true, value: { items: [] } },
    }))

    await expect(probeDshServer(url)).resolves.toBe(false)
  })
})
