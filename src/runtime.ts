import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import * as vscode from 'vscode'
import { DEEPSEEK_API_KEY_SECRET } from './credentials.js'
import { parseDshWebUrl, resolveLaunch } from './launch.js'

export type RuntimeState =
  | { kind: 'stopped' }
  | { kind: 'starting'; detail: string }
  | { kind: 'ready'; localUri: vscode.Uri }
  | { kind: 'failed'; message: string }

interface PendingStart {
  resolve(uri: vscode.Uri): void
  reject(error: Error): void
  promise: Promise<vscode.Uri>
}

function deferredStart(): PendingStart {
  let resolve!: (uri: vscode.Uri) => void
  let reject!: (error: Error) => void
  const promise = new Promise<vscode.Uri>((ok, fail) => {
    resolve = ok
    reject = fail
  })
  return { resolve, reject, promise }
}

/** Owns exactly one official DSH child process for the current Extension Host. */
export class DshRuntime implements vscode.Disposable {
  private readonly changes = new vscode.EventEmitter<RuntimeState>()
  private child: ChildProcessWithoutNullStreams | undefined
  private pending: PendingStart | undefined
  private startupTimer: NodeJS.Timeout | undefined
  private stdoutBuffer = ''
  private stopping = false
  private _state: RuntimeState = { kind: 'stopped' }

  readonly onDidChangeState = this.changes.event

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly output: vscode.OutputChannel,
  ) {}

  get state(): RuntimeState {
    return this._state
  }

  private publish(state: RuntimeState): void {
    this._state = state
    this.changes.fire(state)
  }

  async start(workspaceUri?: vscode.Uri): Promise<vscode.Uri> {
    if (this._state.kind === 'ready') return this._state.localUri
    if (this.pending !== undefined) return this.pending.promise
    if (this.child !== undefined) await this.stop()

    const workspace = workspaceUri === undefined
      ? vscode.workspace.workspaceFolders?.[0]?.uri
      : workspaceUri
    if (workspace === undefined) {
      const error = new Error('Open a folder or workspace before starting DeepSeek Harness.')
      this.publish({ kind: 'failed', message: error.message })
      throw error
    }

    const config = vscode.workspace.getConfiguration('deepseekHarness', workspace)
    const configuredExecutable = config.get<string>('executable', '')
    const args = config.get<string[]>('arguments', ['web', '--host', '127.0.0.1', '--port', '0'])
    const timeoutMs = config.get<number>('startupTimeout', 60_000)
    const launch = resolveLaunch(this.context.extensionUri.fsPath, configuredExecutable, args, {
      cwd: workspace.fsPath,
    })
    const storedApiKey = await this.context.secrets.get(DEEPSEEK_API_KEY_SECRET)

    const pending = deferredStart()
    this.pending = pending
    this.stdoutBuffer = ''
    this.stopping = false
    const renderedCommand = [launch.command, ...launch.args].map(part => JSON.stringify(part)).join(' ')
    this.output.appendLine(`[runtime] cwd: ${workspace.fsPath}`)
    this.output.appendLine(`[runtime] launch: ${renderedCommand}`)
    if (storedApiKey !== undefined) this.output.appendLine('[runtime] DeepSeek credential: VS Code SecretStorage')
    this.publish({
      kind: 'starting',
      detail: launch.sourceCheckout ? 'Starting the official DSH source profile…' : 'Starting the official DSH profile…',
    })

    let child: ChildProcessWithoutNullStreams
    try {
      child = spawn(launch.command, launch.args, {
        cwd: workspace.fsPath,
        env: {
          ...process.env,
          NO_COLOR: '1',
          ...(storedApiKey === undefined ? {} : { DEEPSEEK_API_KEY: storedApiKey }),
          ...launch.env,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      })
    } catch (error) {
      this.failStart(error instanceof Error ? error : new Error(String(error)))
      return pending.promise
    }
    this.child = child

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => { this.consumeStdout(chunk) })
    child.stderr.on('data', (chunk: string) => { this.output.append(chunk) })
    child.on('error', (error) => {
      if (child.pid === undefined) this.child = undefined
      this.failStart(error)
    })
    child.on('exit', (code, signal) => {
      this.clearStartupTimer()
      this.child = undefined
      const detail = `DSH exited (${signal ?? `code ${String(code)}`}).`
      this.output.appendLine(`[runtime] ${detail}`)
      if (this.stopping) {
        this.publish({ kind: 'stopped' })
        return
      }
      if (this.pending !== undefined) {
        this.failStart(new Error(detail))
      } else {
        this.publish({ kind: 'failed', message: detail })
      }
    })

    this.startupTimer = setTimeout(() => {
      this.failStart(new Error(`DSH did not report a web URL within ${String(timeoutMs)} ms.`))
      void this.stop()
    }, timeoutMs)

    return pending.promise
  }

  private consumeStdout(chunk: string): void {
    this.output.append(chunk)
    this.stdoutBuffer += chunk
    let newline = this.stdoutBuffer.indexOf('\n')
    while (newline !== -1) {
      const line = this.stdoutBuffer.slice(0, newline).replace(/\r$/, '')
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1)
      this.acceptOutputLine(line)
      newline = this.stdoutBuffer.indexOf('\n')
    }
  }

  private acceptOutputLine(line: string): void {
    if (this.pending === undefined) return
    const url = parseDshWebUrl(line)
    if (url === undefined) return
    const localUri = vscode.Uri.parse(url)
    const pending = this.pending
    this.pending = undefined
    this.clearStartupTimer()
    this.publish({ kind: 'ready', localUri })
    pending.resolve(localUri)
  }

  private failStart(error: Error): void {
    const pending = this.pending
    if (pending === undefined) {
      if (!this.stopping) this.publish({ kind: 'failed', message: error.message })
      return
    }
    this.pending = undefined
    this.clearStartupTimer()
    this.publish({ kind: 'failed', message: error.message })
    pending.reject(error)
  }

  private clearStartupTimer(): void {
    if (this.startupTimer === undefined) return
    clearTimeout(this.startupTimer)
    this.startupTimer = undefined
  }

  async restart(): Promise<vscode.Uri> {
    await this.stop()
    return this.start()
  }

  async stop(): Promise<void> {
    this.stopping = true
    this.clearStartupTimer()
    const child = this.child
    this.child = undefined
    const pending = this.pending
    this.pending = undefined
    pending?.reject(new Error('DSH runtime stopped.'))
    if (child === undefined || child.exitCode !== null) {
      this.publish({ kind: 'stopped' })
      return
    }

    await new Promise<void>((resolve) => {
      let settled = false
      let forceTimer: NodeJS.Timeout | undefined
      const finish = (): void => {
        if (settled) return
        settled = true
        if (forceTimer !== undefined) clearTimeout(forceTimer)
        resolve()
      }
      child.once('exit', finish)
      forceTimer = setTimeout(() => {
        child.kill('SIGKILL')
        finish()
      }, 4_000)
      if (!child.kill('SIGTERM')) finish()
    })
    this.publish({ kind: 'stopped' })
  }

  dispose(): void {
    this.changes.dispose()
    void this.stop()
  }
}
