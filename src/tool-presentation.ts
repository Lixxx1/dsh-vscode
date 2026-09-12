import type { DshEvent } from './conversation.js'

type RecordValue = Record<string, unknown>
export interface FileDiff { path: string; oldText: string | null; newText: string }
export type FileMutation =
  | { kind: 'write'; path: string; content: string }
  | { kind: 'edit'; path: string; oldText: string; newText: string; replaceAll: boolean }

export function toolRecord(value: unknown): RecordValue | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as RecordValue : undefined
}

export function toolArguments(value: unknown): RecordValue | undefined {
  if (typeof value !== 'string') return toolRecord(value)
  try { return toolRecord(JSON.parse(value)) } catch { return undefined }
}

/** Only interpret the official filesystem tools; opaque plugin metadata stays opaque. */
export function fileMutation(name: string, raw: unknown): FileMutation | undefined {
  const args = toolArguments(raw)
  if (typeof args?.file_path !== 'string' || args.file_path.trim() === '') return undefined
  if (name === 'write' && typeof args.content === 'string') return { kind: 'write', path: args.file_path, content: args.content }
  if (name === 'edit' && typeof args.old_string === 'string' && args.old_string !== '' && typeof args.new_string === 'string'
    && (args.replace_all === undefined || typeof args.replace_all === 'boolean')) {
    return { kind: 'edit', path: args.file_path, oldText: args.old_string, newText: args.new_string, replaceAll: args.replace_all === true }
  }
  return undefined
}

export function mutationDiff(mutation: FileMutation): FileDiff {
  return { path: mutation.path, oldText: mutation.kind === 'edit' ? mutation.oldText : null,
    newText: mutation.kind === 'edit' ? mutation.newText : mutation.content }
}

/** The persisted 0.1.2 fs result metadata contains applied contextual hunks, not full files. */
export function diffsFromMeta(meta: unknown): FileDiff[] | undefined {
  const values = toolRecord(meta)?.diffs
  if (!Array.isArray(values)) return undefined
  const diffs: FileDiff[] = []
  for (const value of values) {
    const diff = toolRecord(value)
    if (typeof diff?.path !== 'string' || diff.path.trim() === '' || (diff.oldText !== null && typeof diff.oldText !== 'string')
      || typeof diff.newText !== 'string') return undefined
    diffs.push({ path: diff.path, oldText: diff.oldText, newText: diff.newText })
  }
  return diffs
}

export function toolResultText(event: DshEvent): string {
  const message = toolRecord(toolRecord(event.data)?.message)
  const result = Array.isArray(message?.content) ? toolRecord(message.content[0]) : undefined
  if (typeof result?.content === 'string') return result.content
  if (!Array.isArray(result?.content)) return ''
  return result.content.flatMap(value => {
    const part = toolRecord(value)
    return part?.type === 'text' && typeof part.text === 'string' ? [part.text] : []
  }).join('\n')
}

/** A successful write can have no hunks for a create, a no-op, or an oversized diff basis. */
export function writeCreated(event: DshEvent): boolean {
  return /^<path>[^\n]*<\/path>\n<type>file<\/type>\n<content>\nCreated file\n<\/content>$/.test(toolResultText(event))
}

/** Mirror the official Bash/PowerShell trailing status-marker contract on replay. */
function shellResult(text: string): RecordValue {
  const signal = /\n\[killed by signal: ([^\]\n]+)\]$/.exec(text)
  if (signal?.[1] !== undefined) return { output: text.slice(0, signal.index), signal: signal[1] }
  const exit = /\n\[exit code: (\d+)\]$/.exec(text)
  if (exit?.[1] !== undefined && Number.isSafeInteger(Number(exit[1]))) {
    return { output: text.slice(0, exit.index), exitCode: Number(exit[1]) }
  }
  return { output: text, exitCode: 0 }
}

export function presentToolCall(name: string, raw: unknown): RecordValue | undefined {
  const args = toolArguments(raw)
  if (args === undefined) return undefined
  const mutation = fileMutation(name, args)
  if (mutation !== undefined) return { card: 'diff', title: `${name === 'write' ? 'Write' : 'Edit'} ${mutation.path}`,
    diffs: [mutationDiff(mutation)], locations: [{ path: mutation.path }] }
  if (name === 'read' && typeof args.file_path === 'string') return { card: 'generic', title: `Read ${args.file_path}`,
    locations: [{ path: args.file_path, line: typeof args.offset === 'number' ? args.offset : 1 }] }
  if ((name === 'bash' || name === 'pwsh') && typeof args.command === 'string') {
    if (args.run_in_background === true) return { card: 'generic', title: args.command,
      ...(typeof args.description === 'string' ? { content: [{ type: 'text', text: args.description }] } : {}) }
    const cwd = typeof args.workdir === 'string' ? args.workdir : args.cwd
    return { card: 'terminal', title: args.command, ...(typeof cwd === 'string' ? { cwd } : {}),
      ...(typeof args.description === 'string' ? { description: args.description } : {}) }
  }
  if ((name === 'grep' || name === 'glob') && typeof args.pattern === 'string') {
    return { card: 'generic', title: `${name === 'grep' ? 'Grep' : 'Glob'} ${args.pattern}` }
  }
  return undefined
}

/** Rebuild built-in cards from durable events; never execute plugin presenter code in VS Code. */
export function presentToolResult(name: string, raw: unknown, event: DshEvent, failed: boolean): RecordValue | undefined {
  const data = toolRecord(event.data)
  const meta = toolRecord(data?.meta)
  const call = presentToolCall(name, raw)
  const text = toolResultText(event)
  if (call === undefined && text === '' && meta === undefined) return undefined
  const generic: RecordValue = { card: 'generic', ...(call?.title === undefined ? {} : { title: call.title }), content: [{ type: 'text', text }] }
  if (failed) return generic
  const mutation = fileMutation(name, raw)
  if (mutation !== undefined) {
    const diffs = diffsFromMeta(meta)
    if (diffs !== undefined && diffs.length > 0) return { card: 'diff', title: call?.title, diffs }
    if (mutation.kind === 'write' && writeCreated(event)) return { card: 'diff', title: call?.title, diffs: [mutationDiff(mutation)] }
    return generic
  }
  if (name === 'read' && meta !== undefined) {
    const { path, offset, lines, totalLines } = meta
    if (typeof path === 'string' && Number.isSafeInteger(offset) && (offset as number) > 0
      && Number.isSafeInteger(totalLines) && (totalLines as number) >= 0 && Array.isArray(lines)) {
      let previous = (offset as number) - 1
      const valid = lines.every(value => {
        const line = toolRecord(value)
        if (line === undefined || !Number.isSafeInteger(line.number) || (line.number as number) <= previous
          || (line.number as number) > (totalLines as number) || typeof line.text !== 'string') return false
        previous = line.number as number
        return true
      })
      if (valid) return { card: 'read', title: call?.title, path, offset, lines, totalLines }
    }
  }
  if ((name === 'glob' || name === 'grep') && meta !== undefined && typeof meta.truncated === 'boolean'
    && Number.isSafeInteger(meta.total) && (meta.total as number) >= 0) {
    if (meta.shape === 'paths' && Array.isArray(meta.paths) && meta.paths.every(p => typeof p === 'string')) {
      return { card: 'search', title: call?.title, shape: 'paths', paths: meta.paths, truncated: meta.truncated, total: meta.total }
    }
    if (meta.shape === 'matches' && Array.isArray(meta.files) && meta.files.every(value => {
      const file = toolRecord(value)
      return typeof file?.path === 'string' && Array.isArray(file.matches) && file.matches.every(value => {
        const match = toolRecord(value)
        return typeof match?.line === 'string' && Number.isSafeInteger(match.lineNumber) && (match.lineNumber as number) > 0
      })
    })) return { card: 'search', title: call?.title, shape: 'matches', files: meta.files, truncated: meta.truncated, total: meta.total }
  }
  if ((name === 'bash' || name === 'pwsh') && toolArguments(raw)?.run_in_background !== true) {
    return { card: 'terminal', title: call?.title, ...shellResult(text) }
  }
  return generic
}
