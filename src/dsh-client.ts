import { randomUUID } from 'node:crypto'
import type { DshEvent } from './conversation.js'
import type { PluginInventorySnapshot } from './plugin-profile.js'
import type { SettingsDescription, SettingsMutation, SettingsNamespace } from './runtime-settings.js'

export interface SessionSummary {
  sessionId: string
  updatedAt: number
  running: boolean
  blank: boolean
  cwd?: string
  origin?: 'subagent'
  agentPreset?: string
  projections?: { values?: Record<string, unknown> }
}

export interface HistoryEntry {
  event: DshEvent
  view?: unknown
}

export interface ModelSelection {
  provider: string
  model: string
  reasoningEffort?: string
}

export interface CommandDescriptor {
  name: string
  description: string
  input?: { hint: string }
}

export interface CommandExecution {
  commandId: string
  result: {
    kind: 'success' | 'error'
    text?: string
    sourceEventSeq?: number
  }
}

export interface SkillDescriptor {
  name: string
  description: string
  whenToUse?: string
  modelInvocable: boolean
}

export interface AgentPresetDescriptor {
  id: string
  trust: 'system' | 'user'
  isDefault: boolean
  name?: string
  description?: string
  broken?: string
}

export interface AgentPresetRoster {
  presets: AgentPresetDescriptor[]
  authorable: boolean
  hasDocument: boolean
}

export type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'

export interface PromptImage {
  type: 'image'
  mediaType: ImageMediaType
  data: string
  name?: string
}

export interface ImageAttachment {
  attachmentId: string
  mediaType: ImageMediaType
  bytes: number
  width: number
  height: number
  name?: string
}

export type PromptMode = 'queue' | 'steer'

export type QueueAction =
  | { kind: 'edit'; content: Array<{ type: 'text'; text: string }> }
  | { kind: 'remove' }
  | { kind: 'steer' }

export interface RpcReceipt {
  accepted: boolean
  reason?: 'not-pending' | 'bad-response'
}

export interface ModelOption extends ModelSelection {
  label: string
}

export interface SessionModels {
  current: ModelSelection
  routable: boolean
  groups: Array<{
    id: string
    name: string
    models: Array<{
      id: string
      name: string
      reasoning?: { efforts: Array<{ id: string; name: string }>; defaultEffort?: string }
    }>
  }>
  failures: Array<{ id: string; name: string; message: string }>
}

export type DshFrame =
  | { channel: 'mux'; rpcId: string; payload: Record<string, unknown> }
  | { channel: 'host'; rpcId: string; payload: Record<string, unknown> }

interface RpcEnvelope<T> {
  type: 'server-response'
  rpcId: string
  result: { ok: true; value: T } | { ok: false; error: { message?: string; code?: string } }
}

interface ServerRequestEnvelope {
  type: 'server-request'
  rpcId: string
  method: string
  payload: unknown
}

export class DshClient {
  private readonly streamAbort = new AbortController()
  private readonly frameListeners = new Set<(frame: DshFrame) => void>()
  private readonly errorListeners = new Set<(error: Error) => void>()

  constructor(private readonly baseUrl: URL) {}

  onFrame(listener: (frame: DshFrame) => void): () => void {
    this.frameListeners.add(listener)
    return () => { this.frameListeners.delete(listener) }
  }

  onError(listener: (error: Error) => void): () => void {
    this.errorListeners.add(listener)
    return () => { this.errorListeners.delete(listener) }
  }

  startStreams(): void {
    this.openWebSocket('events.mux', 'mux')
    this.openWebSocket('events.host', 'host')
  }

  listSessions(): Promise<{ items: SessionSummary[] }> {
    return this.call('session.list', {})
  }

  createSession(cwd: string): Promise<{ sessionId: string; agentPreset?: string }> {
    return this.call('session.create', { cwd })
  }

  history(sessionId: string, beforeSeq?: number): Promise<{ events: HistoryEntry[]; hasMore: boolean }> {
    return this.call('session.history', {
      sessionId,
      ...(beforeSeq === undefined ? {} : { beforeSeq }),
      maxMessages: 100,
    })
  }

  models(sessionId: string): Promise<SessionModels> {
    return this.call('session.models', { sessionId })
  }

  attachment(sessionId: string, attachmentId: string): Promise<{ attachment: ImageAttachment; data: string }> {
    return this.call('session.attachment', { sessionId, attachmentId })
  }

  pluginInventory(): Promise<PluginInventorySnapshot> {
    return this.call('pluginInventory/list', { args: {} })
  }

  settings(): Promise<SettingsDescription> {
    return this.call('settings.describe', {})
  }

  mutateSettings(ns: string, ops: SettingsMutation[], expectedRevision: number): Promise<SettingsNamespace> {
    return this.call('settings.mutate', { ns, ops, expectedRevision })
  }

  prompt(
    sessionId: string,
    text: string,
    images: readonly PromptImage[] = [],
    mode: PromptMode = 'queue',
  ): Promise<{ accepted: true }> {
    const content: Array<{ type: 'text'; text: string } | PromptImage> = images.map(image => ({
      type: 'image',
      mediaType: image.mediaType,
      data: image.data,
      ...(image.name === undefined ? {} : { name: image.name }),
    }))
    if (text !== '') content.push({ type: 'text', text })
    return this.call('session.prompt', {
      sessionId,
      mode,
      content,
      clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    })
  }

  async respond(rpcId: string, value: unknown): Promise<RpcReceipt> {
    const response = await fetch(new URL('/api/respond', this.baseUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'client-response',
        rpcId,
        result: { ok: true, value },
      }),
      signal: AbortSignal.timeout(30_000),
    })
    if (!response.ok) throw new Error(`DSH response transport failed: HTTP ${String(response.status)}`)
    const receipt = await response.json() as RpcReceipt
    if (receipt.accepted !== true) {
      throw new Error(receipt.reason === 'not-pending'
        ? 'This request has already been answered.'
        : 'DeepSeek Harness rejected the response.')
    }
    return receipt
  }

  cancel(sessionId: string): Promise<{ accepted: true }> {
    return this.call('session.cancel', { sessionId })
  }

  updateQueue(sessionId: string, itemId: string, action: QueueAction): Promise<{ accepted: true }> {
    return this.call('session.updateQueue', { sessionId, itemId, action })
  }

  selectModel(sessionId: string, selection: ModelSelection): Promise<{ selected: ModelSelection }> {
    return this.call('session.selectModel', { sessionId, ...selection })
  }

  listCommands(sessionId: string): Promise<CommandDescriptor[]> {
    return this.call('commands/list', { args: { agentId: sessionId } }, 10_000)
  }

  async listSkills(sessionId: string): Promise<SkillDescriptor[]> {
    const result = await this.call<{ skills: SkillDescriptor[] }>('skill.list', { sessionId }, 10_000)
    return result.skills
  }

  listAgentPresets(): Promise<AgentPresetRoster> {
    return this.call('agentPreset.list', {}, 10_000)
  }

  selectAgentPreset(sessionId: string, agentPreset: string): Promise<{ agentPreset: string }> {
    return this.call('agentPreset.select', { sessionId, agentPreset }, 30_000)
  }

  executeCommand(sessionId: string, line: string): Promise<CommandExecution | undefined> {
    return this.call('commands/execute', { args: { agentId: sessionId, line } }, 300_000)
  }

  dispose(): void {
    this.streamAbort.abort()
    this.frameListeners.clear()
    this.errorListeners.clear()
  }

  private async call<T>(method: string, payload: unknown, timeoutMs = 30_000): Promise<T> {
    const rpcId = randomUUID()
    const response = await fetch(new URL(`/api/${method}`, this.baseUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId, method, payload }),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) throw new Error(`DSH transport failed: HTTP ${String(response.status)}`)
    const envelope = await response.json() as RpcEnvelope<T>
    if (envelope.type !== 'server-response' || envelope.rpcId !== rpcId) {
      throw new Error(`Invalid DSH response for ${method}.`)
    }
    if (!envelope.result.ok) {
      throw new Error(envelope.result.error.message ?? envelope.result.error.code ?? `${method} failed`)
    }
    return envelope.result.value
  }

  private openWebSocket(path: 'events.mux' | 'events.host', channel: 'mux' | 'host'): void {
    const url = new URL(`/api/${path}`, this.baseUrl)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    const socket = new WebSocket(url)
    let opened = false
    const abort = (): void => {
      if (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN) socket.close()
    }
    this.streamAbort.signal.addEventListener('abort', abort, { once: true })
    socket.addEventListener('open', () => { opened = true }, { once: true })
    socket.addEventListener('message', (event) => {
      try {
        if (typeof event.data !== 'string') throw new Error('DSH sent a binary WebSocket frame.')
        const envelope = JSON.parse(event.data) as ServerRequestEnvelope
        if (envelope.type !== 'server-request' || typeof envelope.payload !== 'object' || envelope.payload === null) {
          throw new Error('DSH sent an invalid event envelope.')
        }
        const frame: DshFrame = { channel, rpcId: envelope.rpcId, payload: envelope.payload as Record<string, unknown> }
        for (const listener of this.frameListeners) listener(frame)
      } catch (error) {
        const normalized = error instanceof Error ? error : new Error(String(error))
        for (const listener of this.errorListeners) listener(normalized)
      }
    })
    socket.addEventListener('error', () => {
      if (this.streamAbort.signal.aborted) return
      const error = new Error(`DSH ${channel} WebSocket ${opened ? 'failed' : 'could not connect'}.`)
      for (const listener of this.errorListeners) listener(error)
    })
    socket.addEventListener('close', () => {
      this.streamAbort.signal.removeEventListener('abort', abort)
      if (this.streamAbort.signal.aborted || !opened) return
      const error = new Error(`DSH ${channel} WebSocket closed.`)
      for (const listener of this.errorListeners) listener(error)
    }, { once: true })
    if (this.streamAbort.signal.aborted) abort()
  }
}
