import { describe, expect, it } from 'vitest'
import type * as vscode from 'vscode'
import { chatHtml as createChatHtml } from '../src/webview.js'

function chatHtml(webview: vscode.Webview, mark: vscode.Uri): string {
  return createChatHtml(webview, mark, {
    script: { toString: () => 'vscode-resource:/dist/webview/markdown.js' } as vscode.Uri,
    style: { toString: () => 'vscode-resource:/dist/webview/katex.min.css' } as vscode.Uri,
  })
}

describe('chat webview', () => {
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
    const detachTail = script.indexOf('detachConversationTail();', historyClick)
    const requestHistory = script.indexOf("vscode.postMessage({ type: 'load-history' })", historyClick)

    expect(historyClick).toBeGreaterThanOrEqual(0)
    expect(detachTail).toBeGreaterThan(historyClick)
    expect(detachTail).toBeLessThan(requestHistory)
  })

  it('updates tail following from every scroll source', () => {
    const webview = { cspSource: 'vscode-webview:' } as vscode.Webview
    const mark = { toString: () => 'vscode-resource:/deepseek.svg' } as vscode.Uri
    const script = /<script nonce="[^"]+">([\s\S]*?)<\/script>/.exec(chatHtml(webview, mark))?.[1] ?? ''

    expect(script).toContain("elements.scroll.addEventListener('scroll', synchronizeConversationTail")
    expect(script).toContain('if (conversationNearBottom()) followConversationTail = true;')
    expect(script).not.toContain("elements.scroll.addEventListener('wheel'")
  })
})
