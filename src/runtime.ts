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
import { DshConnection } from './dsh-connection.js'
import { assertSupportedDshVersion, DSH_UPGRADE_MESSAGE } from './runtime-endpoint.js'
import { redactDshSecrets, RuntimeOutput } from './runtime-output.js'

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
  // stop() can reject while launch preparation is still awaited; the caller
  // receives the same rejection once that preparation settles.
  void promise.catch(() => {})
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
        windowsVerbatimArguments: launch.windowsVerbatimArguments,
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
  private _connection: DshConnection | undefined
  private authenticating: DshConnection | undefined
  private startTask: Promise<vscode.Uri> | undefined
  private stopTask: Promise<void> | undefined
  private stopRevision = 0
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

  get connection(): DshConnection {
    if (this._state.kind !== 'ready' || this._connection === undefined) {
      throw new Error('DeepSeek Harness is not connected.')
    }
    return this._connection
  }

  private publish(state: RuntimeState): void {
    this._state = state
    this.changes.fire(state)
  }

  start(workspaceUri?: vscode.Uri): Promise<vscode.Uri> {
    if (this.startTask !== undefined) return this.startTask
    const task = this.startRuntime(workspaceUri)
    this.startTask = task
    const clear = (): void => { if (this.startTask === task) this.startTask = undefined }
    void task.then(clear, clear)
    return task
  }

  private async startRuntime(workspaceUri?: vscode.Uri): Promise<vscode.Uri> {
    const revision = this.stopRevision
    if (this.stopTask !== undefined) await this.stopTask
    if (revision !== this.stopRevision) throw new Error('DSH runtime stopped.')
    if (this._state.kind === 'ready') return this._state.localUri
    if (this.pending !== undefined) return this.pending.promise
    if (this.child !== undefined) await this.stopRuntime()
    await this.releaseLaunchPreparation()
    if (revision !== this.stopRevision) throw new Error('DSH runtime stopped.')

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
        const connection = new DshConnection(existingUrl)
        const probe = await probeDshServer(connection)
        if (probe.kind === 'ready') {
          if (this.pending !== pending) {
            connection.dispose()
            return pending.promise
          }
          const localUri = vscode.Uri.parse(existingUrl.href)
          this.output.appendLine(`[runtime] reusing existing DSH: ${existingUrl.href}`)
          this._connection = connection
          this.pending = undefined
          this.publish({ kind: 'ready', localUri, ownership: 'external' })
          pending.resolve(localUri)
          return pending.promise
        }
        connection.dispose()
        if (probe.kind === 'authentication-required') {
          this.output.appendLine('[runtime] existing endpoint requires authentication; starting a separate managed DSH runtime.')
        } else if (probe.kind === 'unsupported') {
          this.output.appendLine('[runtime] existing endpoint does not support the required DSH Remote protocol; starting a separate managed runtime.')
        }
        if (this.pending !== pending) return pending.promise
      }
      const versionLaunch = resolveLaunch(this.context.extensionUri.fsPath, configuredExecutable, ['--version'], {
        cwd: workspace.fsPath,
      })
      version = await readDshVersion(versionLaunch, workspace.fsPath)
      if (this.pending !== pending) return pending.promise
      assertSupportedDshVersion(version)
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
    if (version !== undefined) this.output.appendLine(`[runtime] DSH version: ${redactDshSecrets(version)}`)
    this.output.appendLine(`[runtime] launch: ${redactDshSecrets(renderedCommand)}`)
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
        windowsVerbatimArguments: launch.windowsVerbatimArguments,
      })
    } catch (error) {
      this.failStart(error instanceof Error ? error : new Error(String(error)), pending)
      return pending.promise
    }
    this.child = child

    const consume = (line: string): void => {
      if (this.child === child) this.acceptOutputLine(line, pending)
    }
    const stdout = new RuntimeOutput(line => { this.output.appendLine(line) }, consume)
    const stderr = new RuntimeOutput(line => { this.output.appendLine(line) }, consume)
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => { stdout.consume(chunk) })
    child.stderr.on('data', (chunk: string) => { stderr.consume(chunk) })
    child.once('close', () => { stdout.flush(); stderr.flush() })
    child.on('error', (error) => {
      if (this.child !== child) return
      if (child.pid === undefined) this.child = undefined
      this.failStart(error, pending)
    })
    child.on('exit', (code, signal) => {
      // A replaced process must not clear the new startup timer or credentials.
      if (this.child !== child) return
      this.clearStartupTimer()
      this.child = undefined
      this.disposeConnections()
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
      if (this.pending !== pending) return
      this.failStart(new Error(`DSH did not report a web URL within ${String(timeoutMs)} ms.`), pending)
      void this.stop(true)
    }, timeoutMs)

    return pending.promise
  }

  private acceptOutputLine(line: string, pending: PendingStart): void {
    if (this.pending !== pending || this.authenticating !== undefined) return
    const url = parseDshWebUrl(line)
    if (url === undefined) return
    const launchUrl = new URL(url)
    if (!launchUrl.searchParams.has('token')) {
      this.failStart(new Error(DSH_UPGRADE_MESSAGE), pending)
      void this.stop(true)
      return
    }
    const connection = new DshConnection(new URL(launchUrl.origin))
    this.authenticating = connection
    this.publish({ kind: 'starting', detail: 'Authenticating with DeepSeek Harness…' })
    void (async () => {
      await connection.authenticate(launchUrl)
      const probe = await probeDshServer(connection, 10_000)
      if (probe.kind !== 'ready') {
        throw new Error(probe.kind === 'unsupported' ? DSH_UPGRADE_MESSAGE
          : `Could not verify the authenticated DSH Remote service (${probe.kind}). Reconnect the runtime.`)
      }
      if (this.pending !== pending) {
        connection.dispose()
        return
      }
      this.authenticating = undefined
      this._connection = connection
      const localUri = vscode.Uri.parse(connection.baseUrl.href)
      this.pending = undefined
      this.clearStartupTimer()
      this.publish({ kind: 'ready', localUri, ownership: 'managed' })
      pending.resolve(localUri)
    })().catch(error => {
      connection.dispose()
      if (this.pending !== pending) return
      this.failStart(error instanceof Error ? error : new Error('DSH authentication failed.'), pending)
      void this.stop(true)
    })
  }

  private disposeConnections(): void {
    this.authenticating?.dispose()
    this.authenticating = undefined
    this._connection?.dispose()
    this._connection = undefined
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

  stop(preserveFailure = false): Promise<void> {
    this.stopRevision++
    this.startTask = undefined
    if (this.stopTask !== undefined) return this.stopTask
    const task = this.stopRuntime(preserveFailure)
    this.stopTask = task
    const clear = (): void => { if (this.stopTask === task) this.stopTask = undefined }
    void task.then(clear, clear)
    return task
  }

  private async stopRuntime(preserveFailure = false): Promise<void> {
    const state: RuntimeState = preserveFailure && this._state.kind === 'failed' ? this._state : { kind: 'stopped' }
    this.stopping = true
    this.clearStartupTimer()
    this.disposeConnections()
    const child = this.child
    this.child = undefined
    const pending = this.pending
    this.pending = undefined
    pending?.reject(new Error('DSH runtime stopped.'))
    if (child === undefined || child.exitCode !== null) {
      await this.releaseLaunchPreparation()
      this.publish(state)
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
    this.publish(state)
  }

  dispose(): void {
    this.changes.dispose()
    void this.stop()
  }
}
