import type { CommandExecution, PromptImage } from './dsh-client.js'

type Format = 'submittedAttachments' | 'images'
type Call = <T>(endpoint: string, args: Record<string, unknown>, timeoutMs?: number) => Promise<T>

/** Negotiate with an empty, non-executing line; never retry the user's command. */
export class DshCommandTransport {
  private format: Promise<Format> | undefined

  constructor(private readonly call: Call) {}

  async execute(sessionId: string, line: string, images: readonly PromptImage[]): Promise<CommandExecution | undefined> {
    const format = await this.resolveFormat(sessionId)
    const attachments = images.map(({ mediaType, data, name }) => ({
      ...(format === 'submittedAttachments' ? { type: 'image' } : {}),
      mediaType, data, ...(name === undefined ? {} : { name }),
    }))
    return this.call('commands/execute', { agentId: sessionId, line, [format]: attachments }, 300_000)
  }

  private resolveFormat(sessionId: string): Promise<Format> {
    this.format ??= this.probe(sessionId).catch(error => { this.format = undefined; throw error })
    return this.format
  }

  private async probe(sessionId: string): Promise<Format> {
    try {
      // Official execute() parses the line before minting a commandId, emitting
      // lifecycle events, admitting attachments or invoking a command handler.
      const result = await this.call('commands/execute', { agentId: sessionId, line: '', submittedAttachments: [] }, 10_000)
      if (result !== undefined) throw new Error('DSH returned an unexpected command capability response.')
      return 'submittedAttachments'
    } catch (error) {
      // This exact gateway rejection occurs before entering execute(). Other
      // validation, authentication, timeout and transport errors must surface.
      if (error instanceof Error && 'code' in error && error.code === 'gateway/arguments-invalid'
        && error.message.includes('commands/execute: args fields do not match the descriptor:')
        && error.message.includes('missing "images"') && error.message.includes('unexpected "submittedAttachments"')) return 'images'
      throw error
    }
  }
}
