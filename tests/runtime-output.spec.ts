import { describe, expect, it } from 'vitest'
import { RuntimeOutput, redactDshSecrets } from '../src/runtime-output.ts'
import { parseDshWebUrl } from '../src/launch.ts'

describe('runtime output and launch-token privacy', () => {
  it('handles every chunk boundary without logging any part of the launch token', () => {
    const raw = '\u001b[32mdsh web: http://127.0.0.1:3080/?token=secret-token\u001b[0m\r\n'
    for (let offset = 0; offset <= raw.length; offset++) {
      const logs: string[] = []
      const urls: Array<string | undefined> = []
      const output = new RuntimeOutput(line => { logs.push(line) }, line => { urls.push(parseDshWebUrl(line)) })
      output.consume(raw.slice(0, offset))
      output.consume(raw.slice(offset))
      output.flush()
      expect(logs).toEqual(['dsh web: http://127.0.0.1:3080/?token=[redacted]'])
      expect(urls).toEqual(['http://127.0.0.1:3080/?token=secret-token'])
    }
  })

  it('flushes a final unterminated line with the same redaction', () => {
    const logs: string[] = []
    const output = new RuntimeOutput(line => { logs.push(line) }, () => {})
    output.consume('Cookie: dsh-auth-example=secret')
    expect(logs).toEqual([])
    output.flush()
    expect(logs).toEqual(['Cookie: [redacted]'])
  })

  it('discards oversized lines without leaking their prefix and resumes at a newline', () => {
    const logs: string[] = []
    const accepted: string[] = []
    const output = new RuntimeOutput(line => { logs.push(line) }, line => { accepted.push(line) }, 32)
    output.consume('token=' + 'x'.repeat(40))
    output.consume('trailing-secret\nok\n')
    expect(logs).toEqual(['[runtime] oversized output line omitted', 'ok'])
    expect(accepted).toEqual(['ok'])
  })

  it('redacts query tokens, headers and explicit secret values', () => {
    expect(redactDshSecrets('url?token=abc&x=1\nAuthorization: Bearer abc\nCookie: a=b\nplain-secret', ['plain-secret']))
      .toBe('url?token=[redacted]&x=1\nAuthorization: [redacted]\nCookie: [redacted]\n[redacted]')
  })
})
