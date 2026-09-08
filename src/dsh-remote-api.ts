import { randomUUID } from 'node:crypto'
import type { DshConnection } from './dsh-connection.js'
import type { PromptImage, PromptMode, QueueAction, SessionSummary } from './dsh-client.js'

/** Named-argument contracts of the 0.1.2 Session Remotes, independent of the UI. */
export class DshRemoteApi {
  constructor(private readonly connection: DshConnection) {}

  listSessions(): Promise<{ items: SessionSummary[] }> {
    return this.connection.call('session/list', { _request: {} })
  }

  createSession(cwd: string): Promise<{ sessionId: string; agentPreset?: string }> {
    return this.connection.call('session/create', { request: { cwd } })
  }

  renameSession(sessionId: string, title: string): Promise<{ title: string; seq?: number }> {
    return this.connection.call('session/rename', { request: { sessionId, title } })
  }

  prompt(sessionId: string, text: string, images: readonly PromptImage[] = [], mode: PromptMode = 'queue'): Promise<{ accepted: true }> {
    const content: Array<PromptImage | { type: 'text'; text: string }> = images.map(image => ({
      type: 'image', mediaType: image.mediaType, data: image.data,
      ...(image.name === undefined ? {} : { name: image.name }),
    }))
    if (text !== '') content.push({ type: 'text', text })
    return this.connection.call('session/prompt', {
      request: {
        requestId: randomUUID(), sessionId, mode, content,
        clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      },
    })
  }

  cancel(sessionId: string): Promise<{ accepted: true }> {
    return this.connection.call('session/cancel', { request: { sessionId } })
  }

  updateQueue(sessionId: string, itemId: string, action: QueueAction): Promise<{ accepted: true }> {
    return this.connection.call('session/updateQueue', { request: { sessionId, itemId, action } })
  }
}
