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
