import { describe, expect, it } from 'vitest'
import { existingRuntimeUrl } from '../src/runtime-target.js'

describe('existing runtime URL', () => {
  it('accepts a full local launch URL on any concrete port', () => {
    expect(existingRuntimeUrl('  http://127.0.0.1:43127/?token=private_token-123\n').href)
      .toBe('http://127.0.0.1:43127/?token=private_token-123')
  })

  it.each([
    'http://example.com/?token=secret', 'http://localhost:3080/?token=secret',
    'https://127.0.0.1/?token=secret', 'http://127.0.0.1:0/?token=secret',
    'http://user:secret@127.0.0.1/?token=secret', 'http://127.0.0.1/api/?token=secret',
    'http://127.0.0.1/?token=secret#fragment', 'http://127.0.0.1/?token=secret&token=another',
    'http://127.0.0.1/?token=secret&redirect=elsewhere', 'http://127.0.0.1/',
    'http://127.0.0.1/?token=', 'http://127.0.0.1/?token=secret%20value',
    'secret', 'http://127.0.0.1/?token=' + 's'.repeat(8192),
  ])('rejects unsafe or incomplete inputs without echoing them (#%#)', value => {
    try { existingRuntimeUrl(value); expect.fail('Should reject') }
    catch (error) {
      expect((error as Error).message).toBe('Paste the full launch URL printed by DSH: http://127.0.0.1:PORT/?token=…')
    }
  })
})
