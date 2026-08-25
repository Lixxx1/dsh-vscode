import { describe, expect, it } from 'vitest'
import { debugRuntimePatch, injectDebugRuntimePatch } from '../src/debug-runtime-patch.ts'

describe('debug runtime patch', () => {
  it('places launcher patches before Web application arguments', () => {
    expect(injectDebugRuntimePatch(
      ['web', '--host', '127.0.0.1', '--port', '0', '--no-open'],
      '/tmp/debug.yml',
    )).toEqual([
      'web', '--patch', '/tmp/debug.yml', '--host', '127.0.0.1', '--port', '0', '--no-open',
    ])
    expect(injectDebugRuntimePatch(
      ['--profile', 'web', '--host', '127.0.0.1'],
      '/tmp/debug.yml',
    )).toEqual([
      '--profile', 'web', '--patch', '/tmp/debug.yml', '--host', '127.0.0.1',
    ])
  })

  it('does not duplicate the same patch and rejects non-Web profiles', () => {
    const args = ['web', '--patch', '/tmp/debug.yml', '--port', '0']
    expect(injectDebugRuntimePatch(args, '/tmp/debug.yml')).toEqual(args)
    expect(() => injectDebugRuntimePatch(['--profile', 'headless'], '/tmp/debug.yml'))
      .toThrow('requires the DSH Web profile')
  })

  it('creates a token-free MCP overlay for the loopback endpoint', () => {
    const patch = debugRuntimePatch(new URL('http://127.0.0.1:43127/mcp'))
    expect(patch).toContain("name: '@deepseek-ai/dsh-mcp-client'")
    expect(patch).toContain('url: http://127.0.0.1:43127/mcp')
    expect(patch).toContain('process.env.DSH_VSCODE_DEBUG_TOKEN')
    expect(patch).not.toContain('Bearer actual-token')
    expect(() => debugRuntimePatch(new URL('http://localhost:43127/mcp'))).toThrow('IPv4 loopback')
  })
})
