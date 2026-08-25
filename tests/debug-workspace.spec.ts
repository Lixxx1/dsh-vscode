import { describe, expect, it } from 'vitest'
import { debugWorkspaceForPath } from '../src/debug-workspace.ts'

function folder(name: string, fsPath: string): never {
  return { name, uri: { fsPath } } as never
}

describe('debug workspace selection', () => {
  it('binds tools to the workspace selected for the runtime launch', () => {
    const frontend = folder('frontend', '/workspace/frontend')
    const backend = folder('backend', '/workspace/backend')

    expect(debugWorkspaceForPath([frontend, backend], '/workspace/backend')).toBe(backend)
    expect(debugWorkspaceForPath([frontend, backend], '/workspace/missing')).toBeUndefined()
  })
})
