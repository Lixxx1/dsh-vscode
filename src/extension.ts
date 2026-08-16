import * as vscode from 'vscode'
import { DshRuntime, type RuntimeState } from './runtime.js'
import { appHtml, errorHtml, loadingHtml } from './webview.js'

let activeRuntime: DshRuntime | undefined

class DshSurface implements vscode.Disposable {
  private readonly receiveDisposable: vscode.Disposable

  constructor(
    private readonly webview: vscode.Webview,
    private readonly runtime: DshRuntime,
    private readonly output: vscode.OutputChannel,
  ) {
    webview.options = { enableScripts: true, localResourceRoots: [] }
    this.receiveDisposable = webview.onDidReceiveMessage((message: unknown) => {
      if (typeof message !== 'object' || message === null || !('type' in message)) return
      const type = (message as { type?: unknown }).type
      if (type === 'restart') void this.runtime.restart().catch(() => undefined)
      if (type === 'output') this.output.show(true)
    })
    this.render(runtime.state)
  }

  render(state: RuntimeState): void {
    switch (state.kind) {
      case 'stopped':
        this.webview.html = loadingHtml(this.webview, 'Waiting to start the official Cordis web profile…')
        break
      case 'starting':
        this.webview.html = loadingHtml(this.webview, state.detail)
        break
      case 'ready':
        this.webview.html = appHtml(this.webview, state.externalUri)
        break
      case 'failed':
        this.webview.html = errorHtml(this.webview, state.message)
        break
    }
  }

  dispose(): void {
    this.receiveDisposable.dispose()
  }
}

class DshViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private surface: DshSurface | undefined

  constructor(
    private readonly runtime: DshRuntime,
    private readonly output: vscode.OutputChannel,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.surface?.dispose()
    const surface = new DshSurface(view.webview, this.runtime, this.output)
    this.surface = surface
    view.onDidDispose(() => {
      surface.dispose()
      if (this.surface === surface) this.surface = undefined
    })

    const autoStart = vscode.workspace.getConfiguration('deepseekHarness').get<boolean>('autoStart', true)
    if (autoStart) void this.runtime.start().catch(() => undefined)
  }

  render(state: RuntimeState): void {
    this.surface?.render(state)
  }

  dispose(): void {
    this.surface?.dispose()
    this.surface = undefined
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('DeepSeek Harness', { log: true })
  const runtime = new DshRuntime(context, output)
  activeRuntime = runtime
  const provider = new DshViewProvider(runtime, output)
  const panels = new Set<{ panel: vscode.WebviewPanel; surface: DshSurface }>()

  context.subscriptions.push(output, runtime, provider)
  context.subscriptions.push(runtime.onDidChangeState((state) => {
    provider.render(state)
    for (const entry of panels) entry.surface.render(state)
  }))
  context.subscriptions.push(vscode.window.registerWebviewViewProvider(
    'deepseekHarness.chat',
    provider,
    { webviewOptions: { retainContextWhenHidden: true } },
  ))

  context.subscriptions.push(vscode.commands.registerCommand('deepseekHarness.openInEditor', async () => {
    const panel = vscode.window.createWebviewPanel(
      'deepseekHarness.editor',
      'DeepSeek Harness',
      vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true },
    )
    const entry = { panel, surface: new DshSurface(panel.webview, runtime, output) }
    panels.add(entry)
    panel.onDidDispose(() => {
      entry.surface.dispose()
      panels.delete(entry)
    })
    await runtime.start().catch(() => undefined)
  }))

  context.subscriptions.push(vscode.commands.registerCommand('deepseekHarness.restart', async () => {
    await runtime.restart().catch((error: unknown) => {
      void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error))
    })
  }))

  context.subscriptions.push(vscode.commands.registerCommand('deepseekHarness.showOutput', () => {
    output.show(true)
  }))

  context.subscriptions.push(vscode.commands.registerCommand('deepseekHarness.openInBrowser', async () => {
    try {
      const uri = await runtime.start()
      await vscode.env.openExternal(uri)
    } catch (error) {
      void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error))
    }
  }))
}

export async function deactivate(): Promise<void> {
  const runtime = activeRuntime
  activeRuntime = undefined
  await runtime?.stop()
}
