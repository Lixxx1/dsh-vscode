import { createHash } from 'node:crypto'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  version: '0.1.2-rc.1',
  timeout: 60_000,
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
      get: (key: string, fallback: unknown) => key === 'reuseExistingRuntime' ? false
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

const runtimes: DshRuntime[] = []
function runtime(): { instance: DshRuntime; logs: string[] } {
  const logs: string[] = []
  const instance = new DshRuntime({
    extensionUri: { fsPath: '/extension' }, secrets: { get: async () => undefined },
  } as never, { appendLine: (line: string) => { logs.push(line) } } as never)
  runtimes.push(instance)
  return { instance, logs }
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
  vi.stubGlobal('fetch', vi.fn(async (_url: URL, init?: RequestInit) => init?.method === 'GET' ? authResponse() : rpcResponse(init)))
})

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map(instance => instance.stop()))
  vi.unstubAllGlobals()
})

describe('authenticated runtime startup', () => {
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
