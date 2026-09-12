import { createHash } from 'node:crypto'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  version: '0.1.2-rc.1',
  timeout: 60_000,
  reuse: false,
  debugging: false,
  children: [] as ChildProcessWithoutNullStreams[],
}))

vi.mock('vscode', () => ({
  EventEmitter: class {
    readonly event = vi.fn()
    fire(): void {}
    dispose(): void {}
  },
  Uri: { parse: (value: string) => ({ toString: () => value, fsPath: '/workspace' }) },
  workspace: {
    workspaceFolders: [{ uri: { fsPath: '/workspace' } }],
    getConfiguration: () => ({
      get: (key: string, fallback: unknown) => key === 'reuseExistingRuntime' ? state.reuse
        : key === 'autonomousDebugging' ? state.debugging
        : key === 'startupTimeout' ? state.timeout : fallback,
      inspect: () => undefined,
    }),
  },
}))

vi.mock('../src/launch.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../src/launch.ts')>(),
  findSourceRoot: () => undefined,
  resolveLaunch: (_root: string, _executable: string, args: string[]) => ({ command: 'dsh', args, env: {} }),
}))

vi.mock('node:child_process', async () => {
  const { EventEmitter } = await import('node:events')
  const { PassThrough } = await import('node:stream')
  return {
    spawn: vi.fn((_command: string, args: string[]) => {
      const child = Object.assign(new EventEmitter(), {
        pid: 123, exitCode: null as number | null, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
      }) as unknown as ChildProcessWithoutNullStreams
      if (args.includes('--version')) {
        queueMicrotask(() => {
          child.stdout.emit('data', state.version + '\n')
          child.emit('exit', 0)
          child.emit('close', 0)
        })
      } else {
        state.children.push(child)
      }
      return child
    }),
  }
})

vi.mock('../src/process-tree.ts', () => ({
  terminateProcessTree: (child: ChildProcessWithoutNullStreams) => {
    child.emit('exit', 0)
    child.emit('close', 0)
    return true
  },
}))

import { DshRuntime } from '../src/runtime.ts'
import type { RuntimeLaunchContributor } from '../src/runtime-launch.js'

const runtimes: DshRuntime[] = []
function runtime(contributor?: RuntimeLaunchContributor) {
  const logs: string[] = []
  const readSecret = vi.fn(async () => undefined)
  const instance = new DshRuntime({
    extensionUri: { fsPath: '/extension' }, secrets: { get: readSecret },
  } as never, { appendLine: (line: string) => { logs.push(line) } } as never, contributor)
  runtimes.push(instance)
  return { instance, logs, readSecret }
}

function authResponse(): Response {
  const name = `dsh-auth-${createHash('sha256').update('127.0.0.1:43127').digest('base64url')}`
  return new Response(null, { status: 303, headers: { location: '/', 'set-cookie': `${name}=v1.dGVzdA.c2lnbmF0dXJl` } })
}

function rpcResponse(init?: RequestInit): Response {
  const message = JSON.parse(String(init?.body))
  return Response.json({ type: 'server-response', rpcId: message.rpcId, result: { ok: true, value: { items: [] } } })
}

beforeEach(() => {
  state.children = []
  state.version = '0.1.2-rc.1'
  state.timeout = 60_000
  state.reuse = false
  state.debugging = false
  vi.mocked(spawn).mockClear()
  vi.stubGlobal('fetch', vi.fn(async (_url: URL, init?: RequestInit) => init?.method === 'GET' ? authResponse() : rpcResponse(init)))
})

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map(instance => instance.stop()))
  vi.unstubAllGlobals()
})

describe('authenticated runtime startup', () => {
  const external = { kind: 'external' as const, launchUrl: new URL('http://127.0.0.1:43127/?token=private-token') }

  it('offers an explicit choice for an authenticated existing runtime instead of spawning another', async () => {
    state.reuse = true
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 401 })))
    const { instance, readSecret } = runtime()
    await expect(instance.start()).rejects.toThrow('requires its launch URL')
    expect(instance.state).toMatchObject({ kind: 'failed', reason: 'runtime-auth' })
    expect(spawn).not.toHaveBeenCalled()
    expect(readSecret).not.toHaveBeenCalled()
  })

  it('skips automatic reuse when the user explicitly chooses a managed runtime', async () => {
    state.reuse = true
    const { instance } = runtime()
    const pending = instance.start(undefined, { kind: 'managed' })
    await vi.waitFor(() => expect(state.children).toHaveLength(1))
    expect(fetch).not.toHaveBeenCalled()
    state.children[0]!.stdout.emit('data', `dsh web: ${external.launchUrl.href}\n`)
    await pending
    expect(instance.state).toMatchObject({ kind: 'ready', ownership: 'managed' })
  })

  it('connects without a CLI, API key or launch patch, and never owns the external process', async () => {
    const prepare = vi.fn(async () => undefined)
    const { instance, logs, readSecret } = runtime({ prepare })
    const uri = await instance.start(undefined, external)
    expect(uri.toString()).toBe('http://127.0.0.1:43127/')
    expect(instance.state).toMatchObject({ kind: 'ready', ownership: 'external' })
    expect(instance.connection.authenticated).toBe(true)
    expect(prepare).not.toHaveBeenCalled()
    expect(readSecret).not.toHaveBeenCalled()
    expect(spawn).not.toHaveBeenCalled()
    const connection = instance.connection
    const calls = vi.mocked(fetch).mock.calls
    expect(calls.map(c => new URL(String(c[0])).pathname)).toEqual(['/', '/api/session/list'])
    expect(calls[1]?.[1]?.headers).toHaveProperty('cookie')
    expect(JSON.stringify({ state: instance.state, logs })).not.toContain('private-token')
    await instance.stop()
    expect(connection.authenticated).toBe(false)
    expect(state.children).toHaveLength(0)
    expect(instance.state.kind).toBe('stopped')
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('allows retrying external authentication and never silently falls back to a managed process', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response('private-token', { status: 401 }))
    const { instance, logs } = runtime()
    await expect(instance.start(undefined, external)).rejects.toThrow('did not accept')
    expect(instance.state).toMatchObject({ kind: 'failed', reason: 'runtime-auth' })
    expect(spawn).not.toHaveBeenCalled()
    expect(JSON.stringify({ state: instance.state, logs })).not.toContain('private-token')
    await instance.start(undefined, external)
    expect(instance.state).toMatchObject({ kind: 'ready', ownership: 'external' })
  })

  it('does not accept an authenticated endpoint without the Remote protocol', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url: URL, init?: RequestInit) => init?.method === 'GET'
      ? authResponse() : new Response(null, { status: 404 })))
    const { instance } = runtime()
    await expect(instance.start(undefined, external)).rejects.toThrow('0.1.2-rc.1')
    expect(instance.state).toMatchObject({ kind: 'failed', reason: 'runtime-auth' })
    expect(spawn).not.toHaveBeenCalled()
  })

  it('does not contact an unsafe external URL', async () => {
    const { instance } = runtime()
    await expect(instance.start(undefined, { kind: 'external', launchUrl: new URL('http://example.com/?token=secret') }))
      .rejects.toThrow('Paste the full launch URL')
    expect(fetch).not.toHaveBeenCalled()
    expect(spawn).not.toHaveBeenCalled()
  })

  it('does not attach autonomous debugging to an external runtime', async () => {
    state.debugging = true
    const prepare = vi.fn(async () => undefined)
    const { instance } = runtime({ prepare })
    await expect(instance.start(undefined, external)).rejects.toThrow('managed runtime')
    expect(prepare).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
    expect(spawn).not.toHaveBeenCalled()
  })

  it('ignores a cancelled external handshake after a replacement has connected', async () => {
    let finish!: (response: Response) => void
    vi.mocked(fetch).mockImplementationOnce(() => new Promise<Response>(resolve => { finish = resolve }))
    const { instance } = runtime()
    const first = instance.start(undefined, external)
    const checked = expect(first).rejects.toThrow('stopped')
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1))
    await instance.stop()
    await checked
    await instance.start(undefined, { kind: 'external', launchUrl: new URL('http://127.0.0.1:43127/?token=replacement') })
    finish(authResponse())
    await new Promise(resolve => setImmediate(resolve))
    expect(instance.state).toMatchObject({ kind: 'ready', ownership: 'external' })
    expect(instance.connection.browserUrl().search).toBe('?token=replacement')
    expect(fetch).toHaveBeenCalledTimes(3)
    expect(spawn).not.toHaveBeenCalled()
  })

  it('rejects changing targets while a connection is active', async () => {
    const { instance } = runtime()
    await instance.start(undefined, external)
    await expect(instance.start(undefined, { kind: 'managed' })).rejects.toThrow('Disconnect the current runtime')
    expect(instance.state).toMatchObject({ kind: 'ready', ownership: 'external' })
    expect(spawn).not.toHaveBeenCalled()
  })

  it('waits for authentication and a Remote probe before publishing a credential-free ready state', async () => {
    let finishAuth!: (response: Response) => void
    const auth = new Promise<Response>(resolve => { finishAuth = resolve })
    vi.stubGlobal('fetch', vi.fn(async (_url: URL, init?: RequestInit) => init?.method === 'GET' ? auth : rpcResponse(init)))
    const { instance, logs } = runtime()
    const pending = instance.start()
    await vi.waitFor(() => { expect(state.children).toHaveLength(1) })
    state.children[0]!.stdout.emit('data', 'dsh web: http://127.0.0.1:43127/?to')
    state.children[0]!.stdout.emit('data', 'ken=private-launch-token\r\n')
    expect(instance.state.kind).toBe('starting')
    expect(() => instance.connection).toThrow('not connected')
    finishAuth(authResponse())
    const uri = await pending
    expect(uri.toString()).toBe('http://127.0.0.1:43127/')
    expect(instance.state.kind).toBe('ready')
    expect(JSON.stringify(instance.state)).not.toContain('private-launch-token')
    expect(logs.join('\n')).not.toContain('private-launch-token')
    expect(instance.connection.browserUrl().search).toBe('?token=private-launch-token')
  })

  it('also accepts and redacts launch URLs on stderr', async () => {
    const { instance, logs } = runtime()
    const pending = instance.start()
    await vi.waitFor(() => { expect(state.children).toHaveLength(1) })
    state.children[0]!.stderr.emit('data', '\u001b[32mdsh web: http://127.0.0.1:43127/?token=secret\u001b[0m\n')
    await pending
    expect(instance.state.kind).toBe('ready')
    expect(logs.join('\n')).not.toContain('token=secret')
  })

  it('rejects older DSH before spawning its web process', async () => {
    state.version = '0.1.1-rc.2'
    const { instance } = runtime()
    await expect(instance.start()).rejects.toThrow('0.1.2-rc.1')
    expect(state.children).toEqual([])
    expect(instance.state.kind).toBe('failed')
  })

  it('does not report ready after stop interrupts an authentication request', async () => {
    let finishAuth!: (response: Response) => void
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => { finishAuth = resolve })))
    const { instance } = runtime()
    const pending = instance.start()
    const checked = expect(pending).rejects.toThrow('stopped')
    await vi.waitFor(() => { expect(state.children).toHaveLength(1) })
    state.children[0]!.stdout.emit('data', 'dsh web: http://127.0.0.1:43127/?token=secret\n')
    await instance.stop()
    finishAuth(authResponse())
    await checked
    await new Promise(resolve => { setImmediate(resolve) })
    expect(instance.state.kind).toBe('stopped')
    expect(() => instance.connection).toThrow('not connected')
  })

  it('preserves an authentication error after terminating its managed process', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('private-token', { status: 401 })))
    const { instance, logs } = runtime()
    const pending = instance.start()
    const checked = expect(pending).rejects.toThrow('did not accept')
    await vi.waitFor(() => { expect(state.children).toHaveLength(1) })
    state.children[0]!.stdout.emit('data', 'dsh web: http://127.0.0.1:43127/?token=private-token\n')
    await checked
    await new Promise(resolve => { setImmediate(resolve) })
    expect(instance.state).toMatchObject({ kind: 'failed', message: expect.stringContaining('did not accept') })
    expect(logs.join('\n')).not.toContain('private-token')
  })

  it('ignores a late exit from a replaced process', async () => {
    const { instance } = runtime()
    const first = instance.start()
    await vi.waitFor(() => { expect(state.children).toHaveLength(1) })
    const old = state.children[0]!
    old.stdout.emit('data', 'dsh web: http://127.0.0.1:43127/?token=first\n')
    await first
    await instance.stop()
    const second = instance.start()
    await vi.waitFor(() => { expect(state.children).toHaveLength(2) })
    state.children[1]!.stdout.emit('data', 'dsh web: http://127.0.0.1:43127/?token=second\n')
    await second
    old.emit('exit', 1)
    expect(instance.state.kind).toBe('ready')
    expect(instance.connection.authenticated).toBe(true)
  })

  it('shares concurrent startup callers', async () => {
    const { instance } = runtime()
    const first = instance.start()
    const second = instance.start()
    await vi.waitFor(() => { expect(state.children).toHaveLength(1) })
    state.children[0]!.stdout.emit('data', 'dsh web: http://127.0.0.1:43127/?token=secret\n')
    expect((await first).toString()).toBe((await second).toString())
  })

  it('can stop before startup has reserved its pending connection', async () => {
    const { instance } = runtime()
    const pending = instance.start()
    const checked = expect(pending).rejects.toThrow('stopped')
    await instance.stop()
    await checked
    expect(state.children).toEqual([])
  })

  it('preserves a startup timeout and ignores a late launch URL', async () => {
    state.timeout = 20
    const { instance } = runtime()
    await expect(instance.start()).rejects.toThrow('within 20 ms')
    await new Promise(resolve => { setImmediate(resolve) })
    state.children[0]!.stdout.emit('data', 'dsh web: http://127.0.0.1:43127/?token=too-late\n')
    expect(instance.state).toMatchObject({ kind: 'failed', message: expect.stringContaining('within 20 ms') })
    expect(vi.mocked(fetch)).not.toHaveBeenCalled()
  })
})
