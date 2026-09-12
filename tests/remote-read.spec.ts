import { describe, expect, it, vi } from 'vitest'
import { RemoteRead } from '../src/remote-read.js'

describe('RemoteRead', () => {
  it('shares reads and re-reads once after a burst of invalidations during a request', async () => {
    const first = Promise.withResolvers<string>()
    const fetch = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue('new')
    const read = new RemoteRead<string>(fetch, new AbortController().signal)
    const a = read.read(), b = read.read()
    read.invalidate(); read.invalidate(); read.invalidate()
    first.resolve('stale')
    expect(await Promise.all([a, b])).toEqual(['new', 'new'])
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(await read.read()).toBe('new')
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('ignores errors from superseded requests, but reports and allows retry after a current failure', async () => {
    const first = Promise.withResolvers<string>()
    const fetch = vi.fn().mockReturnValueOnce(first.promise).mockRejectedValueOnce(new Error('current failure')).mockResolvedValue('retry')
    const read = new RemoteRead<string>(fetch, new AbortController().signal)
    const pending = read.read()
    read.invalidate()
    first.reject(new Error('stale failure'))
    await expect(pending).rejects.toThrow('current failure')
    expect(await read.read()).toBe('retry')
  })

  it('does not return or cache a late response after disposal', async () => {
    const first = Promise.withResolvers<string>(), lifetime = new AbortController()
    const read = new RemoteRead(() => first.promise, lifetime.signal)
    const pending = read.read()
    lifetime.abort(new Error('disposed'))
    first.resolve('late')
    await expect(pending).rejects.toThrow('disposed')
    await expect(read.read()).rejects.toThrow('disposed')
    expect(read.current).toBeUndefined()
  })
})
