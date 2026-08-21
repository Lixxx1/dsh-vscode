import type { ConversationMessage } from './conversation.js'

export const TOOL_OUTPUT_CHAR_LIMIT = 20_000
export const TOOL_OUTPUT_ITEM_LIMIT = 100

export interface ToolOutputPage {
  message: ConversationMessage
  nextCursor?: string
}

interface Cursor {
  section: string
  group: number
  index: number
  offset: number
}

type View = Record<string, unknown>
const genericTextCache = new WeakMap<ConversationMessage, string>()

function record(value: unknown): View | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as View : undefined
}

function cursorOf(value: string | undefined): Cursor {
  if (value === undefined) return { section: '', group: 0, index: 0, offset: 0 }
  try {
    const parsed = JSON.parse(value) as Partial<Cursor>
    return {
      section: typeof parsed.section === 'string' ? parsed.section : '',
      group: Number.isSafeInteger(parsed.group) && Number(parsed.group) >= 0 ? Number(parsed.group) : 0,
      index: Number.isSafeInteger(parsed.index) && Number(parsed.index) >= 0 ? Number(parsed.index) : 0,
      offset: Number.isSafeInteger(parsed.offset) && Number(parsed.offset) >= 0 ? Number(parsed.offset) : 0,
    }
  } catch {
    return { section: '', group: 0, index: 0, offset: 0 }
  }
}

function nextCursor(section: string, index: number, offset = 0, group = 0): string {
  return JSON.stringify({ section, group, index, offset })
}

function textPage(value: string, section: string, cursor: Cursor): { value: string; nextCursor?: string } {
  const offset = cursor.section === section ? cursor.offset : 0
  const end = Math.min(value.length, offset + TOOL_OUTPUT_CHAR_LIMIT)
  return {
    value: value.slice(offset, end),
    ...(end < value.length ? { nextCursor: nextCursor(section, 0, end) } : {}),
  }
}

function contentText(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content.map((part) => {
    const item = record(part)
    if (item === undefined) return ''
    if (typeof item.text === 'string') return item.text
    if (typeof item.content === 'string') return item.content
    return contentText(item.content)
  }).filter(Boolean).join('\n')
}

function printable(value: unknown): string {
  if (typeof value === 'string') return value
  try { return JSON.stringify(value, null, 2) ?? '' } catch { return String(value) }
}

function baseMessage(message: ConversationMessage): ConversationMessage {
  return {
    id: message.id,
    role: message.role,
    text: message.text,
    ...(message.detail === undefined ? {} : { detail: message.detail }),
    ...(message.failed === undefined ? {} : { failed: message.failed }),
  }
}

function terminalPage(message: ConversationMessage, call: View | undefined, result: View | undefined, cursor: Cursor): ToolOutputPage {
  const output = typeof result?.output === 'string'
    ? result.output
    : message.rawResult ?? (typeof call?.title === 'string' ? call.title : '')
  const page = textPage(output, 'output', cursor)
  return {
    message: {
      ...baseMessage(message),
      ...(call === undefined ? {} : { callView: { card: 'terminal', ...(typeof call.cwd === 'string' ? { cwd: call.cwd } : {}) } }),
      resultView: {
        card: 'terminal', output: page.value,
        ...(page.nextCursor === undefined && typeof result?.exitCode === 'number' ? { exitCode: result.exitCode } : {}),
        ...(page.nextCursor === undefined && typeof result?.signal === 'string' ? { signal: result.signal } : {}),
      },
    },
    ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
  }
}

function diffPage(message: ConversationMessage, view: View, cursor: Cursor): ToolOutputPage {
  const diffs = Array.isArray(view.diffs) ? view.diffs.flatMap((value) => {
    const diff = record(value)
    if (diff === undefined) return []
    const path = typeof diff.path === 'string' ? diff.path : 'File change'
    return [
      ...(typeof diff.oldText === 'string' ? [{ path, field: 'oldText', text: diff.oldText }] : []),
      { path, field: 'newText', text: typeof diff.newText === 'string' ? diff.newText : '' },
    ]
  }) : []
  const index = cursor.section === 'diff' ? Math.min(cursor.index, Math.max(0, diffs.length - 1)) : 0
  const part = diffs[index]
  if (part === undefined) return { message: { ...baseMessage(message), resultView: { card: 'diff', diffs: [] } } }
  const end = Math.min(part.text.length, cursor.offset + TOOL_OUTPUT_CHAR_LIMIT)
  const diff = {
    path: part.path,
    [part.field]: part.text.slice(cursor.offset, end),
    ...(cursor.section === 'diff' && cursor.index === index && cursor.offset > 0 ? { continuation: true } : {}),
  }
  const next = end < part.text.length
    ? nextCursor('diff', index, end)
    : index + 1 < diffs.length ? nextCursor('diff', index + 1) : undefined
  return {
    message: { ...baseMessage(message), resultView: { card: 'diff', diffs: [diff] } },
    ...(next === undefined ? {} : { nextCursor: next }),
  }
}

function readPage(message: ConversationMessage, view: View, cursor: Cursor): ToolOutputPage {
  const lines = Array.isArray(view.lines) ? view.lines : []
  if (lines.length === 0) return genericPage(message, view, cursor)
  let index = cursor.section === 'lines' ? cursor.index : 0
  let offset = cursor.section === 'lines' ? cursor.offset : 0
  let budget = TOOL_OUTPUT_CHAR_LIMIT
  const pageLines: unknown[] = []
  while (index < lines.length && pageLines.length < TOOL_OUTPUT_ITEM_LIMIT * 2 && budget > 0) {
    const line = record(lines[index])
    if (line === undefined) { index += 1; offset = 0; continue }
    const text = typeof line.text === 'string' ? line.text : ''
    offset = Math.min(offset, text.length)
    const length = Math.min(text.length - offset, budget)
    pageLines.push({ ...line, text: text.slice(offset, offset + length) })
    budget -= length
    if (offset + length < text.length) { offset += length; break }
    index += 1; offset = 0
  }
  return {
    message: {
      ...baseMessage(message),
      resultView: {
        card: 'read', lines: pageLines,
        ...(typeof view.path === 'string' ? { path: view.path } : {}),
        ...(typeof view.offset === 'number' ? { offset: view.offset } : {}),
      },
    },
    ...(index < lines.length ? { nextCursor: nextCursor('lines', index, offset) } : {}),
  }
}

function searchPage(message: ConversationMessage, view: View, cursor: Cursor): ToolOutputPage {
  if (view.shape === 'paths') {
    const paths = Array.isArray(view.paths) ? view.paths : []
    const index = cursor.section === 'paths' ? cursor.index : 0
    const end = Math.min(paths.length, index + TOOL_OUTPUT_ITEM_LIMIT)
    return {
      message: { ...baseMessage(message), resultView: { card: 'search', shape: 'paths', paths: paths.slice(index, end), ...(view.truncated === true ? { truncated: true, total: view.total } : {}) } },
      ...(end < paths.length ? { nextCursor: nextCursor('paths', end) } : {}),
    }
  }
  const files = Array.isArray(view.files) ? view.files : []
  let group = cursor.section === 'matches' ? cursor.group : 0
  let index = cursor.section === 'matches' ? cursor.index : 0
  let offset = cursor.section === 'matches' ? cursor.offset : 0
  let budget = TOOL_OUTPUT_CHAR_LIMIT
  const pageMatches: Array<{ path: string; match: unknown }> = []
  while (group < files.length && pageMatches.length < TOOL_OUTPUT_ITEM_LIMIT && budget > 0) {
    const file = record(files[group])
    if (file === undefined) { group += 1; index = 0; offset = 0; continue }
    const matches = Array.isArray(file.matches) ? file.matches : []
    if (index >= matches.length) { group += 1; index = 0; offset = 0; continue }
    const match = record(matches[index])
    if (match === undefined) { index += 1; offset = 0; continue }
    const line = typeof match.line === 'string' ? match.line : ''
    offset = Math.min(offset, line.length)
    const length = Math.min(line.length - offset, budget)
    pageMatches.push({ path: typeof file.path === 'string' ? file.path : '', match: { ...match, line: line.slice(offset, offset + length) } })
    budget -= length
    if (offset + length < line.length) { offset += length; break }
    index += 1; offset = 0
  }
  while (group < files.length) {
    const file = record(files[group])
    const matches = file !== undefined && Array.isArray(file.matches) ? file.matches : []
    if (index < matches.length) break
    group += 1; index = 0; offset = 0
  }
  const grouped = new Map<string, unknown[]>()
  for (const item of pageMatches) grouped.set(item.path, [...(grouped.get(item.path) ?? []), item.match])
  return {
    message: { ...baseMessage(message), resultView: { card: 'search', shape: 'matches', files: [...grouped].map(([path, fileMatches]) => ({ path, matches: fileMatches })), ...(view.truncated === true ? { truncated: true, total: view.total } : {}) } },
    ...(group < files.length ? { nextCursor: nextCursor('matches', index, offset, group) } : {}),
  }
}

function webPage(message: ConversationMessage, view: View, cursor: Cursor): ToolOutputPage {
  const answer = typeof view.answer === 'string' ? view.answer : ''
  const sources = Array.isArray(view.sources) ? view.sources : []
  if (cursor.section !== 'sources' && answer.length > 0) {
    const page = textPage(answer, 'answer', cursor)
    const continuation = page.nextCursor ?? (sources.length > 0 ? nextCursor('sources', 0) : undefined)
    return {
      message: { ...baseMessage(message), resultView: { card: 'web', answer: page.value, ...(answer.length > TOOL_OUTPUT_CHAR_LIMIT ? { plainText: true } : {}) } },
      ...(continuation === undefined ? {} : { nextCursor: continuation }),
    }
  }
  const index = cursor.section === 'sources' ? cursor.index : 0
  const end = Math.min(sources.length, index + TOOL_OUTPUT_ITEM_LIMIT)
  return {
    message: { ...baseMessage(message), resultView: { card: 'web', sources: sources.slice(index, end), ...(typeof view.url === 'string' ? { url: view.url } : {}) } },
    ...(end < sources.length ? { nextCursor: nextCursor('sources', end) } : {}),
  }
}

function genericPage(message: ConversationMessage, view: View | undefined, cursor: Cursor): ToolOutputPage {
  const call = record(message.callView)
  const locations = Array.isArray(call?.locations) ? call.locations : []
  if (cursor.section === 'locations') {
    const end = Math.min(locations.length, cursor.index + TOOL_OUTPUT_ITEM_LIMIT)
    return {
      message: { ...baseMessage(message), callView: { card: 'generic', locations: locations.slice(cursor.index, end) }, resultView: { card: 'generic' } },
      ...(end < locations.length ? { nextCursor: nextCursor('locations', end) } : {}),
    }
  }
  let presented = genericTextCache.get(message)
  if (presented === undefined) {
    presented = contentText(view?.content)
    genericTextCache.set(message, presented)
  }
  const raw = presented || message.rawResult || message.rawInput || (view?.rawInput === undefined ? '' : printable(view.rawInput))
  if (raw === '' && locations.length > 0) return genericPage(message, view, { section: 'locations', group: 0, index: 0, offset: 0 })
  const page = textPage(raw, 'raw', cursor)
  const continuation = page.nextCursor ?? (locations.length > 0 ? nextCursor('locations', 0) : undefined)
  return {
    message: {
      ...baseMessage(message),
      resultView: {
        card: 'generic',
        ...(typeof view?.title === 'string' ? { title: view.title } : {}),
        content: [{ text: page.value }],
      },
    },
    ...(continuation === undefined ? {} : { nextCursor: continuation }),
  }
}

function assistantPage(message: ConversationMessage, cursor: Cursor): ToolOutputPage {
  const page = textPage(message.text, 'assistant', cursor)
  return {
    message: {
      ...baseMessage(message),
      text: page.value,
      ...(message.text.length > TOOL_OUTPUT_CHAR_LIMIT ? { resultView: { card: 'assistant-page', plainText: true } } : {}),
    },
    ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
  }
}

export function pageConversationMessage(message: ConversationMessage, cursorValue?: string): ToolOutputPage {
  const call = record(message.callView)
  const result = record(message.resultView)
  const view = result ?? call
  const card = typeof view?.card === 'string' ? view.card : 'generic'
  const cursor = cursorOf(cursorValue)
  const images = message.images ?? []
  if (cursor.section === 'images') {
    const index = Math.min(cursor.index, Math.max(0, images.length - 1))
    return {
      message: { ...baseMessage(message), ...(message.role === 'assistant' ? { text: '' } : {}), resultView: { card: 'generic', title: 'Image output' }, ...(images[index] === undefined ? {} : { images: [images[index]] }) },
      ...(index + 1 < images.length ? { nextCursor: nextCursor('images', index + 1) } : {}),
    }
  }
  const page = message.role === 'assistant'
    ? assistantPage(message, cursor)
    : card === 'terminal'
    ? terminalPage(message, call, result, cursor)
    : card === 'diff' && view !== undefined
      ? diffPage(message, view, cursor)
      : card === 'read' && view !== undefined
        ? readPage(message, view, cursor)
        : card === 'search' && view !== undefined
          ? searchPage(message, view, cursor)
          : card === 'web' && view !== undefined
            ? webPage(message, view, cursor)
            : genericPage(message, view, cursor)
  if (page.nextCursor !== undefined || images.length === 0) return page
  const pageResult = record(page.message.resultView)
  const content = Array.isArray(pageResult?.content) ? pageResult.content : []
  const firstContent = record(content[0])
  const emptyGenericPage = pageResult?.card === 'generic' && content.length <= 1 && (firstContent?.text ?? '') === ''
  if (emptyGenericPage) {
    return pageConversationMessage(message, nextCursor('images', 0))
  }
  return { ...page, nextCursor: nextCursor('images', 0) }
}

/** @deprecated Use pageConversationMessage for tool, command, and assistant bodies. */
export const pageToolOutput = pageConversationMessage
