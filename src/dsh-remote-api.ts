import { randomUUID } from 'node:crypto'
import type { DshConnection } from './dsh-connection.js'
import type { PromptImage, PromptMode, QueueAction, SessionSummary } from './dsh-client.js'

/** Named-argument contracts of the 0.1.2 Session Remotes, independent of the UI. */
export class DshRemoteApi {
  constructor(private readonly connection: DshConnection, private readonly signal?: AbortSignal) {}

  listSessions(): Promise<{ items: SessionSummary[] }> {
    return this.call('session/list', { _request: {} })
  }

  createSession(cwd: string): Promise<{ sessionId: string; agentPreset?: string }> {
    return this.call('session/create', { request: { cwd } })
  }

  renameSession(sessionId: string, title: string): Promise<{ title: string; seq?: number }> {
    return this.call('session/rename', { request: { sessionId, title } })
  }

  prompt(sessionId: string, text: string, images: readonly PromptImage[] = [], mode: PromptMode = 'queue'): Promise<{ accepted: true }> {
    const content: Array<PromptImage | { type: 'text'; text: string }> = images.map(image => ({
      type: 'image', mediaType: image.mediaType, data: image.data,
      ...(image.name === undefined ? {} : { name: image.name }),
    }))
    if (text !== '') content.push({ type: 'text', text })
    return this.call('session/prompt', {
      request: {
        requestId: randomUUID(), sessionId, mode, content,
        clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      },
    })
  }

  cancel(sessionId: string): Promise<{ accepted: true }> {
    return this.call('session/cancel', { request: { sessionId } })
  }

  updateQueue(sessionId: string, itemId: string, action: QueueAction): Promise<{ accepted: true }> {
    return this.call('session/updateQueue', { request: { sessionId, itemId, action } })
  }

  private call<T>(endpoint: string, args: Record<string, unknown>): Promise<T> {
    return this.connection.call(endpoint, args, 30_000, this.signal)
  }
}
