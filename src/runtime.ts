import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import * as vscode from 'vscode'
import { DEEPSEEK_API_KEY_SECRET } from './credentials.js'
import { findSourceRoot, parseDshWebUrl, resolveLaunch, type LaunchCommand, webArgsForDshVersion } from './launch.js'
import {
  DEFAULT_DSH_SERVER_URL,
  DEFAULT_DSH_WEB_ARGS,
  probeDshServer,
  shouldProbeExistingDsh,
} from './runtime-endpoint.js'
import {
  applyRuntimeLaunchPreparation,
  type RuntimeLaunchContributor,
  type RuntimeLaunchPreparation,
} from './runtime-launch.js'
import { terminateProcessTree } from './process-tree.js'

export type RuntimeOwnership = 'external' | 'managed'

export type RuntimeState =
  | { kind: 'stopped' }
  | { kind: 'starting'; detail: string }
  | { kind: 'ready'; localUri: vscode.Uri; ownership: RuntimeOwnership }
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

function readDshVersion(launch: LaunchCommand, cwd: string): Promise<string | undefined> {
  return new Promise(resolve => {
    let settled = false
    let output = ''
    let timer: NodeJS.Timeout | undefined
    const finish = (version?: string): void => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      resolve(version)
    }
    let child: ChildProcessWithoutNullStreams
    try {
      child = spawn(launch.command, launch.args, {
        cwd,
        env: { ...process.env, NO_COLOR: '1', ...launch.env },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      })
    } catch {
      finish()
      return
    }
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => { output += chunk })
    child.stderr.on('data', (chunk: string) => { output += chunk })
    child.on('error', () => { finish() })
    // 'close' (not 'exit') guarantees the stdio streams have flushed, so the
    // version string cannot be truncated by a late stdout chunk.
    child.on('close', code => { finish(code === 0 ? output.trim() : undefined) })
    timer = setTimeout(() => {
      terminateProcessTree(child)
      finish()
    }, 5_000)
  })
}

/** Connects to one official DSH Web runtime, spawning and owning it only when needed. */
export class DshRuntime implements vscode.Disposable {
  private readonly changes = new vscode.EventEmitter<RuntimeState>()
  private child: ChildProcessWithoutNullStreams | undefined
  private pending: PendingStart | undefined
  private startupTimer: NodeJS.Timeout | undefined
  private stdoutBuffer = ''
  private stopping = false
  private launchPreparation: RuntimeLaunchPreparation | undefined
  private launchPreparationRelease: Promise<void> | undefined
  private _state: RuntimeState = { kind: 'stopped' }

  readonly onDidChangeState = this.changes.event

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly output: vscode.OutputChannel,
    private readonly launchContributor?: RuntimeLaunchContributor,
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
    await this.releaseLaunchPreparation()

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
    const configuredArgs = config.get<string[]>('arguments', [...DEFAULT_DSH_WEB_ARGS])
    const inspectedArgs = config.inspect<string[]>('arguments')
    const hasCustomArguments = inspectedArgs?.globalValue !== undefined
      || inspectedArgs?.workspaceValue !== undefined
      || inspectedArgs?.workspaceFolderValue !== undefined
    const reuseExistingRuntime = config.get<boolean>('reuseExistingRuntime', true)
    const timeoutMs = config.get<number>('startupTimeout', 60_000)
    const pending = deferredStart()
    this.pending = pending
    this.stdoutBuffer = ''
    this.stopping = false

    let launch: LaunchCommand
    let version: string | undefined
    let storedApiKey: string | undefined
    try {
      const launchPreparation = await this.launchContributor?.prepare({
        workspacePath: workspace.fsPath,
        configuredExecutable,
        configuredArguments: configuredArgs,
      })
      if (this.pending !== pending) {
        await launchPreparation?.dispose?.()
        return pending.promise
      }
      this.launchPreparation = launchPreparation

      // A nested deepseek-harness checkout is the documented empty-executable
      // launch; an unrelated stock DSH on 3080 must not silently pre-empt it.
      if (launchPreparation === undefined
        && shouldProbeExistingDsh(reuseExistingRuntime, configuredExecutable, hasCustomArguments)
        && findSourceRoot(this.context.extensionUri.fsPath) === undefined) {
        const existingUrl = new URL(DEFAULT_DSH_SERVER_URL)
        this.publish({ kind: 'starting', detail: 'Looking for an existing DeepSeek Harness runtime…' })
        if (await probeDshServer(existingUrl)) {
          if (this.pending !== pending) return pending.promise
          const localUri = vscode.Uri.parse(existingUrl.href)
          this.output.appendLine(`[runtime] reusing existing DSH: ${existingUrl.href}`)
          this.pending = undefined
          this.publish({ kind: 'ready', localUri, ownership: 'external' })
          pending.resolve(localUri)
          return pending.promise
        }
        if (this.pending !== pending) return pending.promise
      }
      const versionLaunch = resolveLaunch(this.context.extensionUri.fsPath, configuredExecutable, ['--version'], {
        cwd: workspace.fsPath,
      })
      version = await readDshVersion(versionLaunch, workspace.fsPath)
      if (this.pending !== pending) return pending.promise
      const versionedArgs = webArgsForDshVersion(configuredArgs, version)
      const args = applyRuntimeLaunchPreparation(versionedArgs, version, launchPreparation)
      launch = resolveLaunch(this.context.extensionUri.fsPath, configuredExecutable, args, {
        cwd: workspace.fsPath,
      })
      storedApiKey = await this.context.secrets.get(DEEPSEEK_API_KEY_SECRET)
      if (this.pending !== pending) return pending.promise
    } catch (error) {
      this.failStart(error instanceof Error ? error : new Error(String(error)), pending)
      return pending.promise
    }

    const renderedCommand = [launch.command, ...launch.args].map(part => JSON.stringify(part)).join(' ')
    this.output.appendLine(`[runtime] cwd: ${workspace.fsPath}`)
    if (version !== undefined) this.output.appendLine(`[runtime] DSH version: ${version}`)
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
          ...this.launchPreparation?.environment,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      })
    } catch (error) {
      this.failStart(error instanceof Error ? error : new Error(String(error)), pending)
      return pending.promise
    }
    this.child = child

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => { this.consumeStdout(chunk) })
    child.stderr.on('data', (chunk: string) => { this.output.append(chunk) })
    child.on('error', (error) => {
      if (child.pid === undefined) this.child = undefined
      this.failStart(error, pending)
    })
    child.on('exit', (code, signal) => {
      this.clearStartupTimer()
      this.child = undefined
      void this.releaseLaunchPreparation()
      const detail = `DSH exited (${signal ?? `code ${String(code)}`}).`
      this.output.appendLine(`[runtime] ${detail}`)
      if (this.stopping) {
        this.publish({ kind: 'stopped' })
        return
      }
      if (this.pending !== undefined) {
        this.failStart(new Error(detail), pending)
      } else {
        this.publish({ kind: 'failed', message: detail })
      }
    })

    this.startupTimer = setTimeout(() => {
      this.failStart(new Error(`DSH did not report a web URL within ${String(timeoutMs)} ms.`), pending)
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
    this.publish({ kind: 'ready', localUri, ownership: 'managed' })
    pending.resolve(localUri)
  }

  private failStart(error: Error, pending: PendingStart): void {
    if (this.pending !== pending) return
    this.pending = undefined
    this.clearStartupTimer()
    this.publish({ kind: 'failed', message: error.message })
    void this.releaseLaunchPreparation()
    pending.reject(error)
  }

  private async releaseLaunchPreparation(): Promise<void> {
    if (this.launchPreparationRelease !== undefined) {
      await this.launchPreparationRelease
      return
    }
    const preparation = this.launchPreparation
    this.launchPreparation = undefined
    if (preparation === undefined) return

    const release = (async () => {
      try {
        await preparation.dispose?.()
      } catch (error) {
        this.output.appendLine(`[runtime] launch contribution cleanup failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    })()
    this.launchPreparationRelease = release
    try {
      await release
    } finally {
      if (this.launchPreparationRelease === release) this.launchPreparationRelease = undefined
    }
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
      await this.releaseLaunchPreparation()
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
        terminateProcessTree(child, 'SIGKILL')
        finish()
      }, 4_000)
      if (!terminateProcessTree(child)) finish()
    })
    await this.releaseLaunchPreparation()
    this.publish({ kind: 'stopped' })
  }

  dispose(): void {
    this.changes.dispose()
    void this.stop()
  }
}
