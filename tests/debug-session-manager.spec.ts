import { describe, expect, it, vi } from 'vitest'

const vscodeMock = vi.hoisted(() => ({
  stopDebugging: vi.fn(async () => {}),
}))

vi.mock('vscode', () => ({
  EventEmitter: class {
    readonly event = vi.fn(() => ({ dispose: vi.fn() }))
    fire(): void {}
    dispose(): void {}
  },
  debug: {
    activeDebugSession: undefined,
    registerDebugAdapterTrackerFactory: vi.fn(() => ({ dispose: vi.fn() })),
    onDidStartDebugSession: vi.fn(() => ({ dispose: vi.fn() })),
    onDidTerminateDebugSession: vi.fn(() => ({ dispose: vi.fn() })),
    stopDebugging: vscodeMock.stopDebugging,
  },
}))

import { DebugSessionManager } from '../src/debug-session-manager.ts'
import { initialDebugSessionState } from '../src/debug-state.ts'

function folder(fsPath: string): never {
  return { uri: { fsPath, toString: () => `file://${fsPath}` } } as never
}

function session(id: string, parentSession?: unknown): never {
  return { id, name: id, type: 'node', parentSession } as never
}

describe('debug session ownership', () => {
  it('stops root sessions and detaches their children when a workspace bridge is disposed', async () => {
    const manager = new DebugSessionManager()
    const root = session('root')
    const child = session('child', root)
    const other = session('other')
    const owned = (manager as unknown as { owned: Map<string, unknown> }).owned
    owned.set('root', { session: root, workspace: 'file:///workspace/one', state: { ...initialDebugSessionState(), phase: 'running' } })
    owned.set('child', { session: child, workspace: 'file:///workspace/one', state: { ...initialDebugSessionState(), phase: 'stopped' } })
    owned.set('other', { session: other, workspace: 'file:///workspace/two', state: { ...initialDebugSessionState(), phase: 'running' } })

    await manager.stopOwnedSessions(folder('/workspace/one'))

    expect(vscodeMock.stopDebugging).toHaveBeenCalledTimes(1)
    expect(vscodeMock.stopDebugging).toHaveBeenCalledWith(root)
    expect([...owned.keys()]).toEqual(['other'])
    manager.dispose()
  })

  it('stops a live child whose parent already terminated', async () => {
    vscodeMock.stopDebugging.mockClear()
    const manager = new DebugSessionManager()
    const root = session('terminated-root')
    const child = session('live-child', root)
    const owned = (manager as unknown as { owned: Map<string, unknown> }).owned
    owned.set('terminated-root', { session: root, workspace: 'file:///workspace/one', state: { ...initialDebugSessionState(), phase: 'terminated' } })
    owned.set('live-child', { session: child, workspace: 'file:///workspace/one', state: { ...initialDebugSessionState(), phase: 'running' } })

    await manager.stopOwnedSessions(folder('/workspace/one'))

    expect(vscodeMock.stopDebugging).toHaveBeenCalledWith(child)
    expect(owned.size).toBe(0)
    manager.dispose()
  })
})
