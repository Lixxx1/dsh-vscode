import * as path from 'node:path'
import type { DshEvent } from './conversation.js'

export interface ToolWriteIntent {
  callId: string
  paths: string[]
}

interface UnknownRecord {
  [key: string]: unknown
}

function record(value: unknown): UnknownRecord | undefined {
  return typeof value === 'object' && value !== null ? value as UnknownRecord : undefined
}

function modifyingTool(name: string): boolean {
  const normalized = name.toLowerCase().split(/[/:.]/).at(-1)
  return normalized === 'write'
    || normalized === 'edit'
    || normalized === 'str_replace_editor'
    || normalized === 'apply_patch'
}

function parsedArguments(value: unknown): UnknownRecord | undefined {
  if (typeof value !== 'string') return record(value)
  try {
    return record(JSON.parse(value))
  } catch {
    return undefined
  }
}

function pathsFromArguments(name: string, value: unknown): string[] {
  if (!modifyingTool(name)) return []
  const args = parsedArguments(value)
  if (args === undefined) return []
  return ['file_path', 'filePath', 'path'].flatMap(key => {
    const candidate = args[key]
    return typeof candidate === 'string' && candidate.trim() !== '' ? [candidate] : []
  })
}

function pathsFromView(value: unknown): string[] {
  const wrapper = record(value)
  const view = wrapper?.for === 'call' ? record(wrapper.view) : record(value)
  if (view?.card !== 'diff' || !Array.isArray(view.diffs)) return []
  return view.diffs.flatMap(diff => {
    const candidate = record(diff)?.path
    return typeof candidate === 'string' && candidate.trim() !== '' ? [candidate] : []
  })
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)]
}

/** Extracts pending file mutations early enough to cancel before dispatch when possible. */
export function toolWriteIntents(event: DshEvent, view?: unknown): ToolWriteIntent[] {
  const data = record(event.data)
  if (data === undefined) return []

  if (event.type === 'assistant/message') {
    const message = record(data.message)
    if (!Array.isArray(message?.content)) return []
    return message.content.flatMap((value): ToolWriteIntent[] => {
      const block = record(value)
      if (block?.type !== 'tool-call' || typeof block.id !== 'string' || typeof block.name !== 'string') return []
      const paths = unique(pathsFromArguments(block.name, block.arguments))
      return paths.length === 0 ? [] : [{ callId: block.id, paths }]
    })
  }

  if (event.type !== 'tool/call' || typeof data.callId !== 'string') return []
  const viewPaths = pathsFromView(view)
  const argumentPaths = typeof data.name === 'string' ? pathsFromArguments(data.name, data.arguments) : []
  const paths = unique([...viewPaths, ...argumentPaths])
  return paths.length === 0 ? [] : [{ callId: data.callId, paths }]
}

/** Resolves model-facing tool paths the same way DSH resolves project-relative paths. */
export function absoluteToolPaths(cwd: string, values: readonly string[]): string[] {
  return unique(values.map(value => path.normalize(path.isAbsolute(value) ? value : path.resolve(cwd, value))))
}
