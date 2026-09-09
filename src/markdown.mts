import DOMPurify from 'dompurify'
import katex from 'katex'
import { Marked, type TokenizerExtension } from 'marked'

interface MathExpression { raw: string; text: string; display: boolean }

function escaped(source: string, index: number): boolean {
  let slashes = 0
  while (index > 0 && source[--index] === '\\') slashes += 1
  return slashes % 2 === 1
}

function mathExpression(source: string): MathExpression | undefined {
  const open = source.startsWith('$$') ? '$$' : source.startsWith('\\[') ? '\\['
    : source.startsWith('\\(') ? '\\(' : source.startsWith('$') ? '$' : undefined
  if (!open) return undefined
  const close = open === '\\[' ? '\\]' : open === '\\(' ? '\\)' : open
  if (open === '$' && (!source[1] || /\s/.test(source[1]))) return undefined
  for (let index = open.length; index < source.length; index += 1) {
    if (open === '$' && source[index] === '\n') return undefined
    if (!source.startsWith(close, index) || escaped(source, index)) continue
    if (open === '$' && (/\s/.test(source[index - 1] ?? '') || /[\d$]/.test(source[index + 1] ?? ''))) continue
    const text = source.slice(open.length, index)
    if (!text.trim()) return undefined
    return { raw: source.slice(0, index + close.length), text, display: open === '$$' || open === '\\[' }
  }
  return undefined
}

function escapeHtml(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
}

export interface MarkdownHooks {
  appendFileText(parent: HTMLElement, text: string): void
  inlineCode(text: string): HTMLElement
  link(href: string, label: string): HTMLElement
}

/** Parse Markdown locally. Model HTML is text, not an executable webview surface. */
export function renderMarkdown(text: string, hooks?: MarkdownHooks): HTMLDivElement {
  const expressions: MathExpression[] = []
  const mathToken = (expression: MathExpression, type: string) => {
    const index = expressions.push(expression) - 1
    return { type, raw: expression.raw, index }
  }
  const inlineMath: TokenizerExtension = {
    name: 'mathInline', level: 'inline',
    start: source => /\$|\\[([]/.exec(source)?.index,
    tokenizer(source) {
      const expression = mathExpression(source)
      return expression ? mathToken(expression, 'mathInline') : undefined
    },
  }
  const blockMath: TokenizerExtension = {
    name: 'mathBlock', level: 'block',
    start: source => /(?:^|\n) {0,3}(?:\$\$|\\\[)/.exec(source)?.index,
    tokenizer(source) {
      const indent = /^ {0,3}(?=\$\$|\\\[)/.exec(source)?.[0]
      if (indent === undefined) return undefined
      const expression = mathExpression(source.slice(indent.length))
      if (!expression) return undefined
      const end = indent.length + expression.raw.length
      const trailing = /^(?:[ \t]*(?:\n|$))/.exec(source.slice(end))
      if (!trailing) return undefined
      return { ...mathToken(expression, 'mathBlock'), raw: source.slice(0, end + trailing[0].length) }
    },
  }
  const parser = new Marked({
    gfm: true, async: false,
    renderer: {
      html: ({ text }) => escapeHtml(text),
      // Attachments are handled separately. Never fetch model-supplied remote images.
      image: ({ text }) => escapeHtml(text),
    },
    extensions: [
      { ...inlineMath, renderer: token => '<span data-math="' + token.index + '"></span>' },
      { ...blockMath, renderer: token => '<div data-math="' + token.index + '"></div>' },
    ],
  })
  const root = document.createElement('div')
  root.className = 'markdown'
  root.append(DOMPurify.sanitize(parser.parse(text) as string, {
    RETURN_DOM_FRAGMENT: true,
    ALLOWED_TAGS: ['p', 'br', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'strong', 'em', 'del',
      'blockquote', 'ul', 'ol', 'li', 'pre', 'code', 'a', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'input', 'span', 'div'],
    ALLOWED_ATTR: ['href', 'title', 'class', 'align', 'start', 'type', 'checked', 'disabled', 'data-math'],
    ALLOW_DATA_ATTR: false,
  }))

  for (const anchor of root.querySelectorAll('a')) {
    const href = anchor.getAttribute('href') ?? ''
    if (!/^https?:\/\//i.test(href)) { anchor.replaceWith(...anchor.childNodes); continue }
    if (hooks) {
      const replacement = hooks.link(href, '')
      replacement.replaceChildren(...anchor.childNodes)
      anchor.replaceWith(replacement)
    }
  }
  if (hooks) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    const texts: Text[] = []
    while (walker.nextNode()) {
      const textNode = walker.currentNode as Text
      if (!textNode.parentElement?.closest('a, pre, code, [data-math]')) texts.push(textNode)
    }
    for (const textNode of texts) {
      const container = document.createElement('span')
      hooks.appendFileText(container, textNode.data)
      textNode.replaceWith(...container.childNodes)
    }
    for (const code of root.querySelectorAll('code')) {
      if (!code.closest('pre')) code.replaceWith(hooks.inlineCode(code.textContent ?? ''))
    }
  }
  for (const table of root.querySelectorAll('table')) {
    const container = document.createElement('div')
    container.className = 'markdown-table'
    container.tabIndex = 0
    container.setAttribute('role', 'region')
    container.setAttribute('aria-label', 'Table (scroll horizontally)')
    table.replaceWith(container)
    container.append(table)
  }
  // Only library-generated math is inserted after sanitization; KaTeX trust is disabled.
  for (const element of root.querySelectorAll<HTMLElement>('[data-math]')) {
    const expression = expressions[Number(element.dataset.math)]
    element.removeAttribute('data-math')
    if (!expression) continue
    element.className = expression.display ? 'markdown-math-display' : 'markdown-math-inline'
    if (expression.display) {
      element.tabIndex = 0
      element.setAttribute('role', 'region')
      element.setAttribute('aria-label', 'Formula (scroll horizontally)')
    }
    try {
      katex.render(expression.text, element, {
        displayMode: expression.display, throwOnError: false, trust: false,
        strict: 'ignore', maxExpand: 1000, maxSize: 20, output: 'htmlAndMathml',
      })
    } catch {
      element.textContent = expression.raw
    }
  }
  return root
}

export interface MarkdownScanState {
  scanOffset: number
  safeBoundary: number
  pendingLine: string
  fence: string
  math: string
}

export function createMarkdownScanState(): MarkdownScanState {
  return { scanOffset: 0, safeBoundary: 0, pendingLine: '', fence: '', math: '' }
}

/** Commit only complete blocks; blank lines inside fenced code or display math aren't boundaries. */
export function scanMarkdownStream(state: MarkdownScanState, text: string): void {
  for (let index = state.scanOffset; index < text.length; index += 1) {
    const character = text[index]!
    if (character !== '\n') { state.pendingLine += character; continue }
    const line = state.pendingLine.replace(/\r$/, '')
    state.pendingLine = ''
    const fence = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line)
    if (state.fence) {
      if (fence && fence[1]![0] === state.fence[0] && fence[1]!.length >= state.fence.length && !fence[2]!.trim()) state.fence = ''
      continue
    }
    if (!state.math && fence) { state.fence = fence[1]!; continue }
    let code = ''
    for (let column = 0; column < line.length; column += 1) {
      if (escaped(line, column)) continue
      if (!state.math && line[column] === '`') {
        const ticks = /^`+/.exec(line.slice(column))![0]
        if (!code) code = ticks
        else if (code === ticks) code = ''
        column += ticks.length - 1
        continue
      }
      if (code) continue
      if (state.math) {
        if (line.startsWith(state.math, column)) { column += state.math.length - 1; state.math = '' }
      } else if (line.startsWith('$$', column)) { state.math = '$$'; column += 1 }
      else if (line.startsWith('\\[', column)) { state.math = '\\]'; column += 1 }
      else if (line.startsWith('\\(', column)) { state.math = '\\)'; column += 1 }
    }
    if (!line.trim() && !state.math) state.safeBoundary = index + 1
  }
  state.scanOffset = text.length
}
