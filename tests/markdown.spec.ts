// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { createMarkdownScanState, renderMarkdown, scanMarkdownStream } from '../src/markdown.mjs'

describe('Markdown rendering', () => {
  it('renders GFM tables with alignment, escaped pipes and inline formatting', () => {
    const root = renderMarkdown('| Name | Value | Status |\n| :--- | ---: | :---: |\n| **Total** | `36` | A\\|B |')
    expect(root.querySelectorAll('table')).toHaveLength(1)
    expect(root.querySelectorAll('th')).toHaveLength(3)
    expect(root.querySelectorAll('td')).toHaveLength(3)
    expect(root.querySelectorAll('th')[1]?.getAttribute('align')).toBe('right')
    expect(root.querySelectorAll('td')[2]?.textContent).toBe('A|B')
    expect(root.querySelector('td strong')?.textContent).toBe('Total')
    expect(root.querySelector('td code')?.textContent).toBe('36')
    expect(root.querySelector('.markdown-table')?.getAttribute('tabindex')).toBe('0')
  })

  it.each([
    ['inline dollars', 'Energy: $E = mc^2$.', false],
    ['inline parentheses', String.raw`Energy: \(E = mc^2\).`, false],
    ['display dollars', '$$\n\\frac{a}{b}\n$$', true],
    ['display brackets', '\\[\n\\sum_{i=1}^{n} i\n\\]', true],
    ['display within text', 'Formula: $$x^2$$ done.', true],
    ['matrix', String.raw`\[\begin{pmatrix}1 & 2 \\ 3 & 4\end{pmatrix}\]`, true],
  ])('renders %s as math', (_label, text, display) => {
    const root = renderMarkdown(text as string)
    expect(root.querySelectorAll('.katex')).toHaveLength(1)
    expect(root.querySelector('math')).not.toBeNull()
    expect(root.querySelectorAll('.markdown-math-display')).toHaveLength(display ? 1 : 0)
    expect(root.querySelector('.katex-error')).toBeNull()
  })

  it('renders math inside tables, lists and emphasis', () => {
    const root = renderMarkdown('| Formula |\n| --- |\n| $x_1$ |\n\n- **Result: $a + b$**')
    expect(root.querySelector('td .katex')).not.toBeNull()
    expect(root.querySelector('li strong .katex')).not.toBeNull()
  })

  it('keeps code, currency, escaped dollars and incomplete formulas as text', () => {
    const source = 'Cost: $5 and $10. Escaped: \\$x\\$. Unfinished: $x + y\n\n`$x$`\n\n~~~tex\n$$x$$\n\\(y\\)\n~~~'
    const root = renderMarkdown(source)
    expect(root.querySelector('.katex')).toBeNull()
    expect(root.textContent).toContain('Cost: $5 and $10.')
    expect(root.textContent).toContain('Escaped: $x$.')
    expect(root.querySelector('pre code')?.textContent).toContain('$$x$$')
  })

  it('retains ordinary Markdown and treats source HTML as literal text', () => {
    const root = renderMarkdown('# Heading\n\n> **bold** and *italic*\n\n1. first\n2. second\n\n<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>')
    expect(root.querySelector('h1')?.textContent).toBe('Heading')
    expect(root.querySelector('blockquote strong')?.textContent).toBe('bold')
    expect(root.querySelectorAll('ol li')).toHaveLength(2)
    expect(root.querySelector('script, img')).toBeNull()
    expect(root.textContent).toContain('<script>alert(1)</script>')
  })

  it('blocks unsafe links, remote images, and trusted KaTeX HTML commands', () => {
    const root = renderMarkdown('[bad](javascript:alert%281%29) [command](command:workbench.action.closeWindow) ![image](https://example.com/pixel.png)\n\n' + String.raw`$\href{javascript:alert(1)}{bad}$ $\includegraphics{https://example.com/pixel.png}$ $\htmlStyle{position:fixed}{x}$`)
    expect(root.querySelector('a, img, script, iframe, style')).toBeNull()
    expect(root.querySelector('[style*="position:fixed"], [style*="position: fixed"]')).toBeNull()
    expect(root.textContent).toContain('bad')
  })

  it('handles invalid TeX without breaking the rest of the message', () => {
    const root = renderMarkdown('$\\notARealCommand{x}$\n\n**Still here**')
    expect(root.textContent).toContain('notARealCommand')
    expect(root.querySelector('strong')?.textContent).toBe('Still here')
  })

  it('preserves file-link and external-link integration without touching code blocks or formulas', () => {
    const seen: string[] = []
    const root = renderMarkdown('src/a.ts:42 and `src/b.ts`\n\n| Link |\n| --- |\n| [**docs**](https://example.com) |\n\n```ts\nsrc/c.ts\n```\n\n$\\text{src/d.ts}$', {
      appendFileText(parent, text) { seen.push(text); parent.append(document.createTextNode(text)) },
      inlineCode(text) { const button = document.createElement('button'); button.textContent = text; return button },
      link(href) { const anchor = document.createElement('a'); anchor.href = href; anchor.dataset.handled = 'true'; return anchor },
    })
    expect(seen.join('')).toContain('src/a.ts:42')
    expect(seen.join('')).not.toMatch(/src\/[bcd]\.ts/)
    expect(root.querySelector('button')?.textContent).toBe('src/b.ts')
    expect(root.querySelector('a[data-handled] strong')?.textContent).toBe('docs')
    expect(root.querySelector('pre code')?.textContent).toContain('src/c.ts')
  })
})

describe('streaming Markdown boundaries', () => {
  it.each(['$$', '\\[', '```', '~~~~'])('does not split %s blocks at internal blank lines, even one character at a time', open => {
    const close = open === '\\[' ? '\\]' : open
    const state = createMarkdownScanState()
    const prefix = 'Hello\n\n'
    const block = `${open}\nx = 1\n\ny = 2\n${close}`
    let text = ''
    for (const character of prefix + block) {
      text += character
      scanMarkdownStream(state, text)
      expect(state.safeBoundary).toBeLessThanOrEqual(prefix.length)
    }
    expect(state.safeBoundary).toBe(prefix.length)
    text += '\n\nTail'
    scanMarkdownStream(state, text)
    expect(state.safeBoundary).toBe(text.length - 4)
  })

  it('ignores math delimiters inside inline code, escaped text and fenced code', () => {
    const source = '`$$` and \\$$\n\n~~~js\n$$\n~~~\n\nDone\n\n'
    const state = createMarkdownScanState()
    scanMarkdownStream(state, source)
    expect(state.safeBoundary).toBe(source.length)
    expect(state.math).toBe('')
    expect(state.fence).toBe('')
  })

  it('does not close a longer fence with three backticks', () => {
    const state = createMarkdownScanState()
    const text = '````md\n```\n\nstill code\n````\n\n'
    scanMarkdownStream(state, text.slice(0, -6))
    expect(state.safeBoundary).toBe(0)
    scanMarkdownStream(state, text)
    expect(state.safeBoundary).toBe(text.length)
  })

  it('renders completed streaming tables and math identically to history', () => {
    const text = 'Intro\n\n| A | B |\n| --- | ---: |\n| $x$ | 36 |\n\n$$\nx + y\n\n+ z\n$$\n\nDone'
    const state = createMarkdownScanState()
    const root = document.createElement('div')
    let committed = 0
    for (let end = 1; end <= text.length; end += 1) {
      scanMarkdownStream(state, text.slice(0, end))
      if (state.safeBoundary > committed) {
        root.append(...renderMarkdown(text.slice(committed, state.safeBoundary)).childNodes)
        committed = state.safeBoundary
      }
    }
    root.append(...renderMarkdown(text.slice(committed)).childNodes)
    expect(root.innerHTML).toBe(renderMarkdown(text).innerHTML)
  })
})
