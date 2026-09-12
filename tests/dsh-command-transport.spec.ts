import { describe, expect, it, vi } from 'vitest'
import { DshCommandTransport } from '../src/dsh-command-transport.js'
import { DshConnectionError } from '../src/dsh-connection.js'

const legacy = () => new DshConnectionError('gateway/arguments-invalid',
  'typert gateway: commands/execute: args fields do not match the descriptor: missing "images"; unexpected "submittedAttachments"')
const image = { type: 'image' as const, mediaType: 'image/png' as const, data: 'YWJj', name: 'example.png' }
const ack = { commandId: 'command', result: { kind: 'success' } }

describe('command attachment format negotiation', () => {
  it('probes once using an empty line, then sends typed attachments to 0.1.5', async () => {
    const call = vi.fn().mockResolvedValueOnce(undefined).mockResolvedValue(ack)
    const transport = new DshCommandTransport(call)
    await transport.execute('s', '/plan inspect', [image])
    await transport.execute('s', '/permission read-only', [])
    expect(call.mock.calls).toEqual([
      ['commands/execute', { agentId: 's', line: '', submittedAttachments: [] }, 10_000],
      ['commands/execute', { agentId: 's', line: '/plan inspect', submittedAttachments: [image] }, 300_000],
      ['commands/execute', { agentId: 's', line: '/permission read-only', submittedAttachments: [] }, 300_000],
    ])
  })

  it('uses 0.1.2 images only after its explicit pre-dispatch descriptor rejection', async () => {
    const call = vi.fn().mockRejectedValueOnce(legacy()).mockResolvedValue(ack)
    const transport = new DshCommandTransport(call)
    await transport.execute('s', '/plan inspect', [image])
    await transport.execute('other', '/plan off', [])
    expect(call.mock.calls.slice(1)).toEqual([
      ['commands/execute', { agentId: 's', line: '/plan inspect', images: [{ mediaType: image.mediaType, data: image.data, name: image.name }] }, 300_000],
      ['commands/execute', { agentId: 'other', line: '/plan off', images: [] }, 300_000],
    ])
  })

  it('coalesces concurrent probes without dropping or replaying either command', async () => {
    const ready = Promise.withResolvers<undefined>()
    const call = vi.fn().mockReturnValueOnce(ready.promise).mockResolvedValue(ack)
    const transport = new DshCommandTransport(call)
    const first = transport.execute('a', '/compact', [])
    const second = transport.execute('b', '/plan', [])
    expect(call).toHaveBeenCalledTimes(1)
    ready.resolve(undefined)
    await Promise.all([first, second])
    expect(call).toHaveBeenCalledTimes(3)
    expect(call.mock.calls.slice(1).map(([, args]) => args.line)).toEqual(['/compact', '/plan'])
  })

  it.each(['authentication-required', 'transport-error', 'cancelled', 'gateway/arguments-invalid'])('does not downgrade on %s or send the command after a failed probe', async code => {
    const call = vi.fn().mockRejectedValueOnce(new DshConnectionError(code, 'Other failure'))
    const transport = new DshCommandTransport(call)
    await expect(transport.execute('s', '/compact', [])).rejects.toThrow('Other failure')
    expect(call).toHaveBeenCalledTimes(1)
    call.mockResolvedValueOnce(undefined).mockResolvedValueOnce(ack)
    await transport.execute('s', '/plan', [])
    expect(call.mock.calls.slice(1).map(([, args]) => args.line)).toEqual(['', '/plan'])
  })

  it('never retries a real command, even when its error looks like a format mismatch', async () => {
    const call = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(legacy())
    const transport = new DshCommandTransport(call)
    await expect(transport.execute('s', '/compact', [])).rejects.toThrow('descriptor')
    expect(call).toHaveBeenCalledTimes(2)
  })
})
