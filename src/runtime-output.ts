import { stripVTControlCharacters } from 'node:util'

export function redactDshSecrets(value: string, secrets: readonly string[] = []): string {
  let text = stripVTControlCharacters(value)
  for (const secret of secrets) {
    if (secret !== '') text = text.split(secret).join('[redacted]')
  }
  return text
    .replace(/([?&](?:token|access_token)=)[^\s&#"']*/gi, '$1[redacted]')
    .replace(/(\b(?:authorization|cookie|set-cookie)\s*:\s*)[^\r\n]*/gi, '$1[redacted]')
}

/** Buffer before logging: a token (or even the word `token`) can span chunks. */
export class RuntimeOutput {
  private buffer = ''
  private discarding = false

  constructor(
    private readonly log: (line: string) => void,
    private readonly accept: (line: string) => void,
    private readonly maxLineLength = 65_536,
  ) {}

  consume(chunk: string): void {
    // Split first so even a very large incoming chunk never becomes retained state.
    const parts = chunk.split(/\r\n|\r|\n/)
    for (let index = 0; index < parts.length; index++) {
      const part = parts[index] ?? ''
      if (!this.discarding) {
        if (this.buffer.length + part.length > this.maxLineLength) {
          this.buffer = ''
          this.discarding = true
          this.log('[runtime] oversized output line omitted')
        } else {
          this.buffer += part
        }
      }
      if (index < parts.length - 1) this.flush()
    }
  }

  flush(): void {
    const line = this.buffer
    this.buffer = ''
    if (this.discarding) {
      this.discarding = false
      return
    }
    if (line === '') return
    this.log(redactDshSecrets(line))
    this.accept(stripVTControlCharacters(line))
  }
}
