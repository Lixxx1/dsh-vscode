import { describe, expect, it, vi } from 'vitest'
import type { DshConnection } from '../src/dsh-connection.ts'
import { DshRemoteApi } from '../src/dsh-remote-api.ts'

describe('DSH 0.1.2 Session Remotes', () => {
  it('uses the exact named arguments for list, create, rename, cancel and queue mutations', async () => {
    const call = vi.fn().mockResolvedValue({ accepted: true })
    const api = new DshRemoteApi({ call } as unknown as DshConnection)
    await api.listSessions()
    await api.createSession('C:\\Users\\测试\\project')
    await api.renameSession('s1', 'A new title')
    await api.cancel('s1')
    await api.updateQueue('s1', 'm1', { kind: 'steer' })
    expect(call.mock.calls).toEqual([
      ['session/list', { _request: {} }],
      ['session/create', { request: { cwd: 'C:\\Users\\测试\\project' } }],
      ['session/rename', { request: { sessionId: 's1', title: 'A new title' } }],
      ['session/cancel', { request: { sessionId: 's1' } }],
      ['session/updateQueue', { request: { sessionId: 's1', itemId: 'm1', action: { kind: 'steer' } } }],
    ])
  })

  it('mints a fresh user-message requestId and preserves image order and steering', async () => {
    const call = vi.fn().mockResolvedValue({ accepted: true })
    const api = new DshRemoteApi({ call } as unknown as DshConnection)
    const image = { type: 'image' as const, mediaType: 'image/png' as const, data: 'YWJj', name: 'diagram.png' }
    await api.prompt('s1', 'inspect this', [image], 'steer')
    await api.prompt('s1', '', [image])
    const first = call.mock.calls[0]![1].request
    const second = call.mock.calls[1]![1].request
    expect(first).toEqual({
      requestId: expect.any(String), sessionId: 's1', mode: 'steer', content: [image, { type: 'text', text: 'inspect this' }],
      clientTimeZone: expect.any(String),
    })
    expect(second.requestId).not.toBe(first.requestId)
    expect(second.content).toEqual([image])
    expect(second.mode).toBe('queue')
  })
})
