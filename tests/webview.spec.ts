// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type * as vscode from 'vscode'
import { chatHtml as createChatHtml } from '../src/webview.js'

function chatHtml(webview: vscode.Webview, mark: vscode.Uri): string {
  return createChatHtml(webview, mark, {
    script: { toString: () => 'vscode-resource:/dist/webview/markdown.js' } as vscode.Uri,
    style: { toString: () => 'vscode-resource:/dist/webview/katex.min.css' } as vscode.Uri,
    scroll: { toString: () => 'vscode-resource:/dist/webview/scroll.js' } as vscode.Uri,
  })
}

function usageFixture() {
  const html = chatHtml({ cspSource: 'vscode-webview:' } as vscode.Webview, { toString: () => 'mark' } as vscode.Uri)
  const dom = new DOMParser().parseFromString(html, 'text/html')
  const elements = {
    usageStats: dom.getElementById('usageStats')!, usageControl: dom.getElementById('usageControl')!,
    usagePanel: dom.getElementById('usagePanel')!, usageTrigger: dom.getElementById('usageTrigger')!,
    usageFill: dom.getElementById('usageFill')!,
  }
  const nodeStart = html.indexOf('function node(')
  const nodeEnd = html.indexOf('function relativeSessionTime(', nodeStart)
  const start = html.indexOf('function formatTokens(')
  const end = html.indexOf('function sameSelection(', start)
  expect(nodeStart).toBeGreaterThan(0)
  expect(nodeEnd).toBeGreaterThan(nodeStart)
  expect(start).toBeGreaterThan(0)
  expect(end).toBeGreaterThan(start)
  const functions = new Function('elements', 'document', 'openContextInspector',
    `let usageOpen = false; ${html.slice(nodeStart, nodeEnd)} ${html.slice(start, end)}; return { formatTokens, renderUsage, usageStats, open: () => { usageOpen = true; } };`)(elements, dom, () => {})
  return { elements, ...functions }
}

describe('chat webview', () => {
  it('formats context token totals without stripping whole-number zeroes in the emitted script', () => {
    const html = chatHtml({ cspSource: 'vscode-webview:' } as vscode.Webview, { toString: () => 'mark' } as vscode.Uri)
    const source = html.slice(html.indexOf('function formatTokens('), html.indexOf('function formatDuration('))
    const format = new Function(`${source}; return formatTokens;`)()
    expect([1000, 10000, 24000, 100000, 1000000, 10000000].map(format)).toEqual(['1K', '10K', '24K', '100K', '1M', '10M'])
  })
  it('places the four extension actions in an accessible webview row and sends their fixed messages', () => {
    const html = chatHtml({ cspSource: 'vscode-webview:' } as vscode.Webview, { toString: () => 'mark' } as vscode.Uri)
    const dom = new DOMParser().parseFromString(html, 'text/html')
    const app = dom.getElementById('app')!
    expect([...app.children].map(child => child.tagName)).toEqual(['HEADER', 'DIV', 'FOOTER'])
    const header = app.firstElementChild!
    expect(header.children[0].classList.contains('toolbar')).toBe(true)
    const actions = header.querySelector('[role="group"][aria-label="DeepSeek actions"]')!
    expect(actions).toBe(header.children[1])
    const expected = [
      ['openInEditor', 'Open in Editor', 'open-in-editor'],
      ['restart', 'Restart Runtime', 'restart'],
      ['managePlugins', 'Manage Plugins', 'manage-plugins'],
      ['configureApiKey', 'Configure API Key', 'configure-api-key'],
    ]
    expect(actions.children).toHaveLength(expected.length)
    const sent: unknown[] = []
    const start = html.indexOf("    document.getElementById('openInEditor').addEventListener")
    const end = html.indexOf("    elements.sessionTrigger.addEventListener", start)
    expect(start).toBeGreaterThan(0)
    expect(end).toBeGreaterThan(start)
    new Function('document', 'vscode', html.slice(start, end))(dom, { postMessage: (message: unknown) => sent.push(message) })
    expected.forEach(([id, label]) => {
      const button = dom.getElementById(id) as HTMLButtonElement
      expect(button.parentElement).toBe(actions)
      expect(button.type).toBe('button')
      expect(button.disabled).toBe(false)
      expect(button.classList.contains('icon-button')).toBe(true)
      expect(button.title).toBe(label)
      expect(button.getAttribute('aria-label')).toBe(label)
      expect(button.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true')
      button.click()
    })
    expect(sent).toEqual(expected.map(([, , type]) => ({ type })))
    expect(html).toContain('grid-template-rows: auto minmax(0, 1fr) auto;')
  })

  it('retains extension commands without native view title contributions', () => {
    const manifest = JSON.parse(readFileSync('package.json', 'utf8'))
    expect(manifest.contributes.menus['view/title']).toBeUndefined()
    const commands = manifest.contributes.commands.map((command: { command: string }) => command.command)
    for (const command of ['openInEditor', 'restart', 'managePlugins', 'configureApiKey']) {
      expect(commands).toContain(`deepseekHarness.${command}`)
    }
    const extension = readFileSync('src/extension.ts', 'utf8')
    expect(extension).toContain("case 'open-in-editor': await vscode.commands.executeCommand('deepseekHarness.openInEditor'); return")
    expect(extension).toContain("case 'manage-plugins': await vscode.commands.executeCommand('deepseekHarness.managePlugins'); return")
  })

  it('renders session metrics and disjoint token shares as separate items', () => {
    const { elements, renderUsage, usageStats } = usageFixture()
    const usageStatsItems = (usage: unknown) => usageStats(usage).items
    const sessionStats = { turns: 2, steps: 4, llmMs: 2000, toolMs: 300, ttftMs: 900, ttftSteps: 2, decodeMs: 2000, decodeTokens: 75 }
    const tokenUsage = { uncachedInputTokens: 100, cacheReadTokens: 300, cacheWriteTokens: 100, outputTokens: 500 }
    renderUsage({ usage: { available: false, sessionStats, tokenUsage } })
    const texts = () => [...elements.usageStats.children].map(child => child.textContent)
    expect(texts()).toEqual(['2 turns', '4 steps', '1K tokens', 'TPS 37.5', 'TTFT avg 450ms', 'Cache hit 60%', 'Cache read 30.0%', 'Input miss 20.0%', 'Output 50.0%', 'Reference cost —'])
    expect([...elements.usageStats.children].every(child => child.tagName === 'SPAN' && child.className === 'usage-stat')).toBe(true)
    expect(elements.usageStats.title).toBe('2 turns · 4 steps  |  LLM 2.0s · tools 300ms  |  TTFT avg 450ms · TPS (aggregate session decode throughput) 37.5 tok/s  |  cache 60%  |  in 500 · out 500')
    expect(elements.usageStats.classList.contains('hidden')).toBe(false)
    expect(elements.usageControl.classList.contains('hidden')).toBe(true)

    const zeros = usageStatsItems({ sessionStats: { ...sessionStats, decodeTokens: 0, ttftMs: 0 }, tokenUsage: { ...tokenUsage, cacheReadTokens: 0 } })
    expect(zeros).toEqual(['2 turns', '4 steps', '700 tokens', 'TPS 0.0', 'TTFT avg 0ms', 'Cache hit 0%', 'Cache read 0.0%', 'Input miss 28.6%', 'Output 71.4%', 'Reference cost —'])
    const outputOnly = usageStatsItems({ sessionStats: { ...sessionStats, decodeMs: 0, ttftSteps: 0 }, tokenUsage: { uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 500 } })
    expect(outputOnly).toEqual(['2 turns', '4 steps', '500 tokens', 'TPS —', 'TTFT avg —', 'Cache hit —', 'Cache read 0.0%', 'Input miss 0.0%', 'Output 100.0%', 'Reference cost —'])
    expect(usageStatsItems({ sessionStats })).toEqual(['2 turns', '4 steps', 'TPS 37.5', 'TTFT avg 450ms', 'Cache hit —', 'Cache read —', 'Input miss —', 'Output —', 'Reference cost —'])
    expect(usageStatsItems({ tokenUsage })).toEqual(['1K tokens', 'TPS —', 'TTFT avg —', 'Cache hit 60%', 'Cache read 30.0%', 'Input miss 20.0%', 'Output 50.0%', 'Reference cost —'])
    const small = usageStatsItems({ tokenUsage: { uncachedInputTokens: 1, cacheReadTokens: 998, cacheWriteTokens: 0, outputTokens: 1 } })
    expect(small.slice(-4, -1)).toEqual(['Cache read 99.8%', 'Input miss 0.1%', 'Output 0.1%'])
    expect(small.slice(-4, -1).reduce((sum: number, item: string) => sum + Number.parseFloat(item.split(' ').at(-1)!), 0)).toBeCloseTo(100, 1)
    expect(usageStats({ tokenUsage: { uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 } })).toEqual({ items: ['TPS —', 'TTFT avg —', 'Cache hit —', 'Cache read —', 'Input miss —', 'Output —', 'Reference cost —'], tooltip: '' })
    expect(usageStats({ tokenUsage: { uncachedInputTokens: 1, cacheReadTokens: 1, outputTokens: 1 } })).toEqual({ items: ['TPS —', 'TTFT avg —', 'Cache hit —', 'Cache read —', 'Input miss —', 'Output —', 'Reference cost —'], tooltip: 'in 0 · out 1' })
    expect(usageStats({})).toEqual({ items: [], tooltip: '' })
    expect(usageStats({ sessionStats: { ...sessionStats, steps: 0 }, tokenUsage })).toEqual({
      items: ['1K tokens', 'TPS 37.5', 'TTFT avg 450ms', 'Cache hit 60%', 'Cache read 30.0%', 'Input miss 20.0%', 'Output 50.0%', 'Reference cost —'],
      tooltip: 'cache 60%  |  in 500 · out 500',
    })
    expect(usageStats({ tokenUsage: { uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 500 } }).tooltip).toBe('in 0 · out 500')
    renderUsage({ usage: { available: false, tokenUsage } })
    expect(texts()).toEqual(['1K tokens', 'TPS —', 'TTFT avg —', 'Cache hit 60%', 'Cache read 30.0%', 'Input miss 20.0%', 'Output 50.0%', 'Reference cost —'])
    renderUsage({})
    expect(texts()).toEqual([])
    expect(elements.usageStats.classList.contains('hidden')).toBe(true)
  })

  it('calculates the cost multiplier using validated raw session tokens and exact model IDs', () => {
    const { usageStats, renderUsage, elements } = usageFixture()
    const hit = { uncachedInputTokens: 0, cacheReadTokens: 100, cacheWriteTokens: 0, outputTokens: 0 }
    const cost = (tokenUsage: unknown, model: string) => usageStats({ tokenUsage }, { model }).items.at(-1)
    for (const model of ['deepseek-flash', 'deepseek-v4-flash', 'deepseek-v4-flash-vision-exp', 'deepseek-v4-pro']) {
      const pro = model === 'deepseek-v4-pro'
      expect(cost(hit, model)).toBe('Reference cost ≈1.00×')
      expect(cost({ ...hit, cacheReadTokens: 0, uncachedInputTokens: 100 }, model)).toBe(`Reference cost ≈${pro ? '30.00' : '50.00'}×`)
      expect(cost({ ...hit, cacheReadTokens: 0, cacheWriteTokens: 100 }, model)).toBe(`Reference cost ≈${pro ? '30.00' : '50.00'}×`)
      expect(cost({ ...hit, cacheReadTokens: 0, outputTokens: 100 }, model)).toBe(`Reference cost ≈${pro ? '90.00' : '200.00'}×`)
      expect(cost({ uncachedInputTokens: 100, cacheReadTokens: 300, cacheWriteTokens: 100, outputTokens: 500 }, model)).toBe(`Reference cost ≈${pro ? '51.30' : '110.30'}×`)
    }
    expect(cost({ ...hit, cacheReadTokens: 9999, outputTokens: 1 }, 'deepseek-flash')).toBe('Reference cost ≈1.02×')
    expect(cost({ ...hit, cacheReadTokens: 0 }, 'deepseek-flash')).toBe('Reference cost —')
    for (const invalid of [undefined, -1, NaN, Infinity, -Infinity]) {
      expect(cost({ ...hit, cacheWriteTokens: invalid }, 'deepseek-flash')).toBe('Reference cost —')
    }
    expect(cost({ ...hit, cacheReadTokens: Number.MAX_VALUE, outputTokens: Number.MAX_VALUE }, 'deepseek-flash')).toBe('Reference cost —')
    expect(cost({ ...hit, cacheReadTokens: Number.MAX_VALUE / 2, outputTokens: Number.MAX_VALUE / 2 }, 'deepseek-flash')).toBe('Reference cost ≈100.50×')
    for (const model of ['deepseek-chat', 'DeepSeek-Flash', 'deepseek-v4-flash-extra', '', 'deepseek-v4-pro ']) expect(cost(hit, model)).toBe('Reference cost —')
    expect(usageStats({ tokenUsage: hit }, { model: 'unknown', label: 'deepseek-flash' }).items.at(-1)).toBe('Reference cost —')
    renderUsage({ usage: { tokenUsage: hit }, models: [{ provider: 'custom', model: 'deepseek-v4-pro', selected: true }] })
    expect(elements.usageStats.lastElementChild?.textContent).toBe('Reference cost ≈1.00×')
    expect(elements.usageStats.title).toContain('Official DeepSeek reference pricing for deepseek-v4-pro: cache hit 1×, input miss 30×, output 90×')
    expect(elements.usageStats.title).toContain('including prior model selections')
    expect(elements.usageStats.title).toContain('excludes non-token charges. Not the actual provider charge.')
  })

  it('formats token counts in the generated script and renders explicit context figures', () => {
    const { elements, formatTokens, renderUsage, open } = usageFixture()
    for (const [value, expected] of [[1000, '1K'], [1500, '1.5K'], [10000, '10K'], [20000, '20K'], [100000, '100K'], [199790, '200K'], [200000, '200K'], [1000000, '1M'], [1500000, '1.5M'], [100000000, '100M']]) {
      expect(formatTokens(value)).toBe(expected)
    }
    open()
    renderUsage({ usage: { available: true, percent: 19, usedTokens: 199790, contextWindow: 1048576, breakdown: { systemTokens: 16, toolsTokens: 397, messageTokens: 148918 } } })
    expect(elements.usagePanel.textContent).toContain('Context19% used')
    expect(elements.usagePanel.textContent).toContain('Estimated usage199,790 tokens')
    expect(elements.usagePanel.textContent).toContain('Context limit1,048,576 tokens')
    expect(elements.usagePanel.textContent).toContain('Content composition (independent estimate)')
    expect(elements.usagePanel.textContent).toContain('Messages~149K')
    const segments = elements.usagePanel.querySelectorAll<HTMLElement>('.usage-segment')
    expect(segments).toHaveLength(1)
    expect(segments[0].style.width).toBe('19%')
    expect(elements.usageTrigger.getAttribute('aria-expanded')).toBe('true')
    renderUsage({ usage: { available: true, percent: 0, usedTokens: 0, contextWindow: 1000000 } })
    expect(elements.usagePanel.textContent).toContain('Estimated usage0 tokens')
    expect(elements.usagePanel.textContent).toContain('Context limit1,000,000 tokens')
    renderUsage({ usage: { available: false } })
    expect(elements.usagePanel.classList.contains('hidden')).toBe(true)
    expect(elements.usageTrigger.getAttribute('aria-expanded')).toBe('false')
  })

  it('keeps model selection enabled when the current model is unroutable, but blocks sending', () => {
    const html = chatHtml({ cspSource: 'vscode-webview:' } as vscode.Webview, { toString: () => 'mark' } as vscode.Uri)
    const source = html.slice(html.indexOf('const sessionReady ='), html.indexOf('elements.cancel.classList.toggle'))
    const elements = { prompt: {}, attach: {}, project: {}, newSession: {}, sessionTrigger: {}, models: {}, efforts: { options: [], value: '' } } as any
    const render = new Function('current', 'elements', source)
    render({ phase: 'ready', sessionId: 's', routable: false, models: [{ model: 'available' }] }, elements)
    expect(elements.models.disabled).toBe(false)
    expect(elements.prompt.disabled).toBe(true)
    render({ phase: 'loading', sessionId: 's', routable: false, models: [{ model: 'available' }] }, elements)
    expect(elements.models.disabled).toBe(true)
  })

  it('does not silently select the first available model when the previous model disappeared', () => {
    const html = chatHtml({ cspSource: 'vscode-webview:' } as vscode.Webview, { toString: () => 'mark' } as vscode.Uri)
    const source = html.slice(html.indexOf('function renderModelOptions('), html.indexOf('function renderAttachments('))
    const options: any[] = []
    const render = new Function('elements', 'Option', 'renderEfforts', `${source}; return renderModelOptions;`)(
      { models: { replaceChildren() { options.length = 0 }, append(value: unknown) { options.push(value) } } },
      function(this: any, label: string, value: string, _default: boolean, selected: boolean) { Object.assign(this, { label, value, selected }) },
      () => {},
    )
    render({ models: [{ provider: 'p', model: 'new', label: 'New', selected: false }] })
    expect(options[0]).toMatchObject({ label: 'Choose a model', value: '', selected: true, disabled: true })
    expect(options[1].selected).toBe(false)
  })

  it('does not invent a selected permission when the current policy is absent from the catalog', () => {
    const html = chatHtml({ cspSource: 'vscode-webview:' } as vscode.Webview, { toString: () => 'mark' } as vscode.Uri)
    expect(html).toContain('const selectedPermission = permissions.find(permission => permission.selected);')
    expect(html).not.toContain('|| permissions[0]')
  })

  it('offers separate reconnect and explicit runtime restart actions', () => {
    const html = chatHtml({ cspSource: 'vscode-webview:' } as vscode.Webview, { toString: () => 'mark' } as vscode.Uri)
    expect(html).toContain("'Reconnect'); retry.addEventListener('click', () => vscode.postMessage({ type: 'reconnect' }))")
    expect(html).toContain("'Restart Runtime'); restart.addEventListener('click', () => vscode.postMessage({ type: 'restart' }))")
    expect(html).toContain('if (current.canReconnect)')
  })

  it('loads bundled Markdown, math CSS and fonts without remote scripts or unsafe script execution', () => {
    const html = chatHtml({ cspSource: 'vscode-webview:' } as vscode.Webview, { toString: () => 'mark.svg' } as vscode.Uri)
    expect(html).toContain('src="vscode-resource:/dist/webview/markdown.js"')
    expect(html).toContain('href="vscode-resource:/dist/webview/katex.min.css"')
    expect(html).toContain('font-src vscode-webview:')
    expect(html).toMatch(/script-src 'nonce-[A-Za-z0-9]+';/)
    expect(html).not.toContain('unsafe-eval')
    expect(html).not.toContain('unsafe-inline')
    expect(html).toContain('dshMarkdown.renderMarkdown')
    expect(html).toContain('dshMarkdown.scanMarkdownStream')
  })
  it('emits valid browser JavaScript', () => {
    const webview = { cspSource: 'vscode-webview:' } as vscode.Webview
    const mark = { toString: () => 'vscode-resource:/deepseek.svg' } as vscode.Uri
    const html = chatHtml(webview, mark)
    const script = /<script nonce="[^"]+">([\s\S]*?)<\/script>/.exec(html)?.[1]

    expect(script).toBeDefined()
    expect(() => new Function(script ?? '')).not.toThrow()
  })

  it('offers a compact GitHub star action in the conversation toolbar', () => {
    const webview = { cspSource: 'vscode-webview:' } as vscode.Webview
    const mark = { toString: () => 'vscode-resource:/deepseek.svg' } as vscode.Uri
    const html = chatHtml(webview, mark)

    expect(html).toContain('aria-label="Star dsh-vscode on GitHub"')
    expect(html).toContain("href: 'https://github.com/Lixxx1/dsh-vscode'")
  })

  it('binds queue actions to the rendered conversation and blocks actions during loading', () => {
    const webview = { cspSource: 'vscode-webview:' } as vscode.Webview
    const mark = { toString: () => 'vscode-resource:/deepseek.svg' } as vscode.Uri
    const html = chatHtml(webview, mark)
    const start = html.indexOf('function postQueueAction(')
    const end = html.indexOf('function renderQueue(', start)
    expect(start).toBeGreaterThan(0)
    expect(end).toBeGreaterThan(start)
    const sent: unknown[] = []
    const state = { phase: 'ready', sessionId: 'a' }
    const post = new Function('state', 'vscode', `${html.slice(start, end)}; return postQueueAction;`)(state, { postMessage: (value: unknown) => sent.push(value) })
    post('a', 'row', 'edit', 'Updated')
    expect(sent).toEqual([{ type: 'queue-action', sessionId: 'a', itemId: 'row', action: 'edit', text: 'Updated' }])
    state.phase = 'loading'
    post('a', 'row', 'remove')
    state.phase = 'ready'
    state.sessionId = 'b'
    post('a', 'row', 'steer')
    expect(sent).toHaveLength(1)
    expect(html).toContain("postQueueAction(sessionId, item.id, 'remove')")
    expect(html).toContain("postQueueAction(sessionId, item.id, 'steer')")
    expect(html).toContain("postQueueAction(sessionId, item.id, 'edit', text)")
    expect(html).toContain('queueEditing.sessionId !== sessionId')
  })

  it('uses a searchable session center with official rename and archive actions', () => {
    const webview = { cspSource: 'vscode-webview:' } as vscode.Webview
    const mark = { toString: () => 'vscode-resource:/deepseek.svg' } as vscode.Uri
    const html = chatHtml(webview, mark)

    expect(html).toContain('placeholder="Search conversations"')
    expect(html).toContain("type: 'rename-session'")
    expect(html).toContain("type: 'archive-session'")
    expect(html).toContain('const sessionDrafts = new Map()')
    expect(html).toContain('const draftImagesBySession = new Map()')
    expect(html).toContain('const pendingDraftSends = new Map()')
    expect(html).toContain("event.data.type === 'restore-draft'")
    expect(html).not.toContain('<select id="sessions"')
  })

  it('renders a compact background-response badge and prioritizes pending requests over Running', () => {
    const html = chatHtml({ cspSource: 'vscode-webview:' } as vscode.Webview, { toString: () => 'mark' } as vscode.Uri)
    const source = html.slice(html.indexOf('function renderSessionCenter('), html.indexOf('function record('))
    const node = (_tag: string, className = '', textContent = ''): any => ({
      className, textContent, title: '', children: [] as any[], attributes: {} as Record<string, string>,
      classList: { toggle(name: string, value: boolean) { this[name as keyof typeof this] = value as never } },
      append(...items: any[]) { this.children.push(...items) }, replaceChildren() { this.children = [] },
      setAttribute(name: string, value: string) { this.attributes[name] = value }, addEventListener() {},
    })
    const badge = node('span')
    const elements = { sessionTrigger: node('button'), sessionTriggerTitle: node('span'), sessionList: node('div'), sessionSearch: { value: '' } }
    const render = new Function('elements', 'document', 'node', 'array', 'string', 'relativeSessionTime', 'sessionActionId',
      `${source}; return renderSessionCenter;`)(elements, { getElementById: () => badge }, node, (a: any) => a, (s: any) => s, () => 'Just now', undefined)
    const current = { sessionId: 'a', sessions: [
      { id: 'a', title: 'Current', blank: true },
      { id: 'b', title: 'Work', blank: true, running: true, attention: { approvals: 2, questions: 1 } },
      { id: 'c', title: 'Question', blank: true, attention: { approvals: 0, questions: 1 } },
    ] }
    render(current)
    expect(badge.textContent).toBe('2')
    expect(badge.classList.hidden).toBe(false)
    expect(elements.sessionTrigger.attributes['aria-label']).toContain('2 other conversation(s) need your response')
    expect(elements.sessionList.children[1].children[0].children[0].className).toBe('session-indicator attention')
    expect(elements.sessionList.children[1].children[0].children[2].textContent).toBe('Awaiting approval')
    expect(elements.sessionList.children[2].children[0].children[2].textContent).toBe('Awaiting your answer')
    render({ ...current, sessionId: 'b', sessions: [current.sessions[1]] })
    expect(badge.classList.hidden).toBe(true)
    expect(elements.sessionTriggerTitle.textContent).toBe('Work')
    render({ sessionId: 'a', sessions: [current.sessions[0]] })
    expect(elements.sessionTrigger.attributes['aria-label']).toBe('Project conversations')
  })

  it('attaches supported clipboard images without intercepting ordinary text paste', () => {
    const webview = { cspSource: 'vscode-webview:' } as vscode.Webview
    const mark = { toString: () => 'vscode-resource:/deepseek.svg' } as vscode.Uri
    const script = /<script nonce="[^"]+">([\s\S]*?)<\/script>/.exec(chatHtml(webview, mark))?.[1] ?? ''

    expect(script).toContain("elements.prompt.addEventListener('paste'")
    expect(script).toContain("if (!files.length) return;")
    expect(script).toContain("item.getAsFile()")
    expect(script).toContain("reader.readAsDataURL(file)")
    expect(script).toContain("type: 'attach-images', sessionId, requestId, images")
    const pasteHandler = script.slice(script.indexOf("elements.prompt.addEventListener('paste'"))
    expect(pasteHandler.indexOf("if (!files.length) return;")).toBeLessThan(pasteHandler.indexOf('event.preventDefault();'))
  })

  it('blocks sending until the extension acknowledges pasted attachments', () => {
    const webview = { cspSource: 'vscode-webview:' } as vscode.Webview
    const mark = { toString: () => 'vscode-resource:/deepseek.svg' } as vscode.Uri
    const script = /<script nonce="[^"]+">([\s\S]*?)<\/script>/.exec(chatHtml(webview, mark))?.[1] ?? ''

    expect(script).toContain('const pendingAttachmentRequests = new Map()')
    expect(script).toContain('pendingAttachmentRequests.set(requestId, { sessionId })')
    expect(script).toContain("request => request.sessionId === sessionId)) return;")
    expect(script).toContain("event.data.type === 'attachments-added'")
    expect(script).toContain('pendingAttachmentRequests.delete(event.data.requestId)')
  })

  it('offers actionable setup states instead of a generic reconnect loop', () => {
    const webview = { cspSource: 'vscode-webview:' } as vscode.Webview
    const mark = { toString: () => 'vscode-resource:/deepseek.svg' } as vscode.Uri
    const html = chatHtml(webview, mark)

    expect(html).toContain('Open a project to get started')
    expect(html).toContain("type: 'open-workspace'")
    expect(html).toContain('Install DeepSeek Harness')
    expect(html).toContain('https://github.com/deepseek-ai/deepseek-harness')
    expect(html).toContain("type: 'configure-api-key'")
    expect(html).toContain("setup === 'runtime-auth'")
    expect(html).toContain("vscode.postMessage({ type: 'connect-existing-runtime' })")
    expect(html).toContain("vscode.postMessage({ type: 'start-managed-runtime' })")
    expect(html).not.toContain('launchUrl')
  })

  it('uses append-only output and streaming paths', () => {
    const webview = { cspSource: 'vscode-webview:' } as vscode.Webview
    const mark = { toString: () => 'vscode-resource:/deepseek.svg' } as vscode.Uri
    const script = /<script nonce="[^"]+">([\s\S]*?)<\/script>/.exec(chatHtml(webview, mark))?.[1] ?? ''

    expect(script).toContain('controller.append(event.data.page.message')
    expect(script).not.toContain('renderedMessages.delete(event.data.messageId)')
    expect(script).not.toContain('value.startsWith(stream.text)')
    expect(script).not.toContain('rendered.node.replaceWith')
    expect(script).toContain("pendingMessageAppends.set(append.id")
    expect(script).toContain("target.textContent += continuation.textContent")
  })

  it('accumulates reasoning-only and metadata-only appends independently of answer text', () => {
    const webview = { cspSource: 'vscode-webview:' } as vscode.Webview
    const mark = { toString: () => 'vscode-resource:/deepseek.svg' } as vscode.Uri
    const script = /<script nonce="[^"]+">([\s\S]*?)<\/script>/.exec(chatHtml(webview, mark))?.[1] ?? ''
    const start = script.indexOf('function invalidateMessageAppends(')
    const end = script.indexOf('\n    function applyStateUpdate(', start + 1)
    const answerAppends = new Map()
    const reasoningAppends = new Map()
    const apply = new Function('pendingMessageAppends', 'pendingReasoningAppends', 'array', 'string', `${script.slice(start, end)}; return applyMessagesPatch;`)(
      answerAppends, reasoningAppends, (value: unknown) => Array.isArray(value) ? value : [], (value: unknown) => typeof value === 'string' ? value : '',
    )
    const initial = [{ id: 'a', role: 'assistant', text: '', streaming: true, reasoning: { text: 'first', active: true, tokens: 1, estimated: true } }]
    const next = apply(initial, { appends: [{ id: 'a', text: '', streaming: true, reasoning: { text: ' next', active: true, tokens: 2, estimated: true } },
      { id: 'a', text: '', streaming: true, reasoning: { text: '', active: false, durationMs: 1500, tokens: 2, estimated: true } }] })
    expect(next[0]).toEqual({ ...initial[0], reasoning: { text: 'first next', active: false, durationMs: 1500, tokens: 2, estimated: true } })
    expect(reasoningAppends.get('a')).toBe(' next')
    expect(answerAppends.get('a')).toBe('')
    const reset = apply(next, { reset: [{ ...next[0], text: 'reset', reasoning: { ...next[0].reasoning, text: 'reset' } }] })
    apply(reset, { appends: [{ id: 'a', text: ' tail', streaming: true, reasoning: { text: ' tail', active: true, tokens: 3, estimated: true } }] })
    expect(answerAppends.get('a')).toBeNull()
    expect(reasoningAppends.get('a')).toBeNull()
  })

  it('does not restore the raw exit marker when a terminal result has an empty output body', () => {
    const webview = { cspSource: 'vscode-webview:' } as vscode.Webview
    const mark = { toString: () => 'vscode-resource:/deepseek.svg' } as vscode.Uri
    const script = /<script nonce="[^"]+">([\s\S]*?)<\/script>/.exec(chatHtml(webview, mark))?.[1] ?? ''
    const start = script.indexOf('function renderToolBody(')
    const end = script.indexOf('\n    function ', start + 1)
    expect(start).toBeGreaterThan(0)
    expect(end).toBeGreaterThan(start)
    const node = (_tag: string, _class?: string, text?: string) => ({ text, children: [] as unknown[], append(...values: unknown[]) { this.children.push(...values) } })
    const render = new Function('node', 'string', 'appendPre', 'appendImages', `${script.slice(start, end)}; return renderToolBody;`)(
      node, (value: unknown) => typeof value === 'string' ? value : '',
      (parent: ReturnType<typeof node>, text: string) => { if (text) parent.append(node('pre', '', text)) },
      () => {},
    )
    const body = render({ rawResult: '\n[exit code: 2]' }, { card: 'terminal', title: 'run' }, { card: 'terminal', output: '', exitCode: 2 })
    expect(body.children).toEqual([{ text: 'Exit 2', children: [], append: expect.any(Function) }])
  })

  it('detaches tail following before loading earlier history', () => {
    const webview = { cspSource: 'vscode-webview:' } as vscode.Webview
    const mark = { toString: () => 'vscode-resource:/deepseek.svg' } as vscode.Uri
    const script = /<script nonce="[^"]+">([\s\S]*?)<\/script>/.exec(chatHtml(webview, mark))?.[1] ?? ''
    const historyClick = script.indexOf("button.addEventListener('click'")
    const detachTail = script.indexOf('conversationScroller.preserveHistory()', historyClick)
    const requestHistory = script.indexOf("vscode.postMessage({ type: 'load-history' })", historyClick)

    expect(historyClick).toBeGreaterThanOrEqual(0)
    expect(detachTail).toBeGreaterThan(historyClick)
    expect(detachTail).toBeLessThan(requestHistory)
  })

  it('loads the scroll controller and exposes a keyboard-accessible jump to latest', () => {
    const webview = { cspSource: 'vscode-webview:' } as vscode.Webview
    const mark = { toString: () => 'vscode-resource:/deepseek.svg' } as vscode.Uri
    const html = chatHtml(webview, mark)
    expect(html).toContain('src="vscode-resource:/dist/webview/scroll.js"')
    expect(html).toContain('aria-label="Jump to latest" aria-controls="scroll" hidden')
    expect(html).toContain('tabindex="0" aria-label="Conversation"')
    expect(html).toContain('dshConversationScroll.createConversationScroller(')
    expect(html).not.toContain('scheduleTailScroll(Boolean(current.approval || current.question))')
  })
})
