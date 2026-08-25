import * as path from 'node:path'
import { realpath } from 'node:fs/promises'
import * as vscode from 'vscode'
import { DebugSessionManager, type DebugSessionSnapshot } from './debug-session-manager.js'
import { compactDebugText, debugVariableValue, launchConfigurationNames, type DebugVariableValue } from './debug-values.js'

type DebugControlAction = 'continue' | 'pause' | 'next' | 'stepIn' | 'stepOut' | 'stop'
type DebugBreakpointAction = 'add' | 'remove' | 'list'

export interface DebugStartInput {
  readonly configuration?: string | undefined
}

export interface DebugBreakpointInput {
  readonly action: DebugBreakpointAction
  readonly path?: string | undefined
  readonly line?: number | undefined
  readonly breakpointId?: string | undefined
}

export interface DebugControlInput {
  readonly action: DebugControlAction
}

export interface DebugStartResult {
  readonly status: 'started' | 'selection-required'
  readonly configurations?: readonly string[]
  readonly session?: DebugSessionSnapshot
}

export interface DebugBreakpointResult {
  readonly breakpoints: readonly DebugBreakpointView[]
}

export interface DebugBreakpointView {
  readonly id: string
  readonly path: string
  readonly line: number
  readonly verified?: boolean
}

export interface DebugStackFrameView {
  readonly id: number
  readonly name: string
  readonly path?: string
  readonly line: number
}

export interface DebugScopeView {
  readonly name: string
  readonly variables: readonly DebugVariableValue[]
}

export interface DebugContextResult {
  readonly session: DebugSessionSnapshot
  readonly frames: readonly DebugStackFrameView[]
  readonly scopes: readonly DebugScopeView[]
  readonly truncated: boolean
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined
}

function integer(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target))
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

function relativePath(root: string, filePath: string): string {
  const relative = path.relative(root, filePath)
  return relative === '' ? path.basename(filePath) : relative.split(path.sep).join('/')
}

/** Implements the four small debugger operations exposed to DSH. */
export class DebugTools implements vscode.Disposable {
  private readonly ownedBreakpoints = new Map<string, vscode.SourceBreakpoint>()
  private readonly breakpointChanges: vscode.Disposable

  constructor(
    private readonly sessions: DebugSessionManager,
    private readonly workspace: vscode.WorkspaceFolder,
  ) {
    this.breakpointChanges = vscode.debug.onDidChangeBreakpoints(event => {
      for (const breakpoint of event.removed) this.ownedBreakpoints.delete(breakpoint.id)
    })
  }

  async start(input: DebugStartInput = {}): Promise<DebugStartResult> {
    const configurations = launchConfigurationNames(
      vscode.workspace.getConfiguration('launch', this.workspace.uri).get<unknown>('configurations'),
    )
    if (configurations.length === 0) {
      throw new Error('No static debug configurations were found. Add a configuration to .vscode/launch.json first.')
    }

    const requested = input.configuration?.trim()
    if (requested === undefined || requested === '') {
      if (configurations.length !== 1) return { status: 'selection-required', configurations }
    } else if (!configurations.includes(requested)) {
      throw new Error(`Unknown debug configuration "${requested}". Available configurations: ${configurations.join(', ')}.`)
    }
    const configuration = requested === undefined || requested === '' ? configurations[0] : requested
    if (configuration === undefined) throw new Error('No debug configuration is available.')

    const dirty = vscode.workspace.textDocuments
      .filter(document => document.isDirty && document.uri.scheme === 'file' && isInside(this.workspace.uri.fsPath, document.uri.fsPath))
      .map(document => relativePath(this.workspace.uri.fsPath, document.uri.fsPath))
    if (dirty.length > 0) {
      throw new Error(`Save or discard unsaved changes before debugging: ${dirty.join(', ')}.`)
    }

    this.sessions.beginLaunch(this.workspace)
    try {
      const started = await vscode.debug.startDebugging(this.workspace, configuration, {
        suppressSaveBeforeStart: true,
      })
      const session = this.sessions.completeLaunch(started)
      if (!started) throw new Error(`VS Code could not start the "${configuration}" debug configuration.`)
      if (session === undefined) throw new Error('VS Code started debugging, but the session was not observed by the DeepSeek bridge.')
      return { status: 'started', session }
    } catch (error) {
      this.sessions.cancelLaunch()
      throw error
    }
  }

  async breakpoint(input: DebugBreakpointInput): Promise<DebugBreakpointResult> {
    if (input.action === 'list') return await this.listBreakpoints()
    if (input.action === 'remove') {
      const breakpointId = input.breakpointId?.trim()
      if (breakpointId === undefined || breakpointId === '') throw new Error('breakpointId is required when removing a breakpoint.')
      const breakpoint = this.ownedBreakpoints.get(breakpointId)
      if (breakpoint === undefined) throw new Error('That breakpoint is not owned by the DeepSeek debug bridge.')
      vscode.debug.removeBreakpoints([breakpoint])
      this.ownedBreakpoints.delete(breakpointId)
      return await this.listBreakpoints()
    }

    const filePath = input.path?.trim()
    if (filePath === undefined || filePath === '') throw new Error('path is required when adding a breakpoint.')
    if (input.line === undefined || !Number.isInteger(input.line) || input.line < 1) {
      throw new Error('line must be a positive, 1-based line number.')
    }
    const absolutePath = path.resolve(this.workspace.uri.fsPath, filePath)
    if (!isInside(this.workspace.uri.fsPath, absolutePath)) throw new Error('Breakpoints must stay inside the current workspace.')
    const uri = vscode.Uri.file(absolutePath)
    try {
      const stat = await vscode.workspace.fs.stat(uri)
      if ((stat.type & vscode.FileType.File) === 0) throw new Error('not a file')
      const [realWorkspacePath, realFilePath] = await Promise.all([
        realpath(this.workspace.uri.fsPath),
        realpath(absolutePath),
      ])
      if (!isInside(realWorkspacePath, realFilePath)) throw new Error('outside workspace')
    } catch {
      throw new Error(`Cannot add a breakpoint because ${relativePath(this.workspace.uri.fsPath, absolutePath)} is not a file.`)
    }
    const breakpoint = new vscode.SourceBreakpoint(
      new vscode.Location(uri, new vscode.Position(input.line - 1, 0)),
    )
    vscode.debug.addBreakpoints([breakpoint])
    this.ownedBreakpoints.set(breakpoint.id, breakpoint)
    return await this.listBreakpoints()
  }

  async control(input: DebugControlInput): Promise<DebugSessionSnapshot> {
    const snapshot = this.sessions.snapshot()
    const session = this.sessions.session(snapshot?.sessionId)
    if (snapshot === undefined || session === undefined) throw new Error('No DeepSeek debug session is active.')

    if (input.action === 'stop') {
      await vscode.debug.stopDebugging(session)
      return await this.sessions.waitFor(snapshot.sessionId, ['terminated'], 3_000)
    }

    const threadId = await this.threadId(session, snapshot)
    if (input.action !== 'pause' && snapshot.phase !== 'stopped') {
      throw new Error(`Cannot ${input.action} while the debug session is ${snapshot.phase}.`)
    }
    if (input.action === 'pause' && snapshot.phase === 'stopped') return snapshot

    const command = input.action
    await session.customRequest(command, { threadId })
    const wanted = input.action === 'continue' ? ['stopped', 'terminated'] as const : ['stopped', 'terminated'] as const
    return await this.sessions.waitFor(snapshot.sessionId, wanted, 3_000)
  }

  async context(): Promise<DebugContextResult> {
    const snapshot = this.sessions.snapshot()
    const session = this.sessions.session(snapshot?.sessionId)
    if (snapshot === undefined || session === undefined) throw new Error('No DeepSeek debug session is active.')
    if (snapshot.phase !== 'stopped') {
      throw new Error(`The debug session is ${snapshot.phase}; pause it or wait for a breakpoint before reading context.`)
    }
    const threadId = await this.threadId(session, snapshot)
    const stackResponse = record(await session.customRequest('stackTrace', { threadId, startFrame: 0, levels: 8 }))
    const rawFrames = Array.isArray(stackResponse?.stackFrames) ? stackResponse.stackFrames : []
    const frames: DebugStackFrameView[] = []
    const frameIds: number[] = []
    for (const rawFrame of rawFrames.slice(0, 8)) {
      const frame = record(rawFrame)
      const id = integer(frame?.id)
      const line = integer(frame?.line)
      if (id === undefined || line === undefined) continue
      const source = record(frame?.source)
      const sourcePath = nonEmptyString(source?.path)
      frames.push({
        id,
        name: compactDebugText(nonEmptyString(frame?.name) ?? '<anonymous>', 160),
        ...(sourcePath === undefined ? {} : {
          path: isInside(this.workspace.uri.fsPath, sourcePath)
            ? relativePath(this.workspace.uri.fsPath, sourcePath)
            : compactDebugText(sourcePath, 240),
        }),
        line,
      })
      frameIds.push(id)
    }
    const frameId = frameIds[0]
    if (frameId === undefined) return { session: snapshot, frames, scopes: [], truncated: false }

    const scopesResponse = record(await session.customRequest('scopes', { frameId }))
    const rawScopes = Array.isArray(scopesResponse?.scopes) ? scopesResponse.scopes : []
    const availableScopes = rawScopes
      .map(record)
      .filter((scope): scope is Record<string, unknown> => scope !== undefined && scope.expensive !== true)
    const localScopes = availableScopes.filter(scope => /local|argument|closure|block/i.test(nonEmptyString(scope.name) ?? ''))
    const preferredScopes = (localScopes.length > 0 ? localScopes : availableScopes).slice(0, 2)
    const scopes: DebugScopeView[] = []
    let variableCount = 0
    for (const scope of preferredScopes) {
      const variablesReference = integer(scope.variablesReference)
      if (variablesReference === undefined || variablesReference <= 0) continue
      const variablesResponse = record(await session.customRequest('variables', {
        variablesReference,
        start: 0,
        count: Math.max(0, 24 - variableCount),
      }))
      const rawVariables = Array.isArray(variablesResponse?.variables) ? variablesResponse.variables : []
      const variables: DebugVariableValue[] = []
      for (const rawVariable of rawVariables.slice(0, Math.max(0, 24 - variableCount))) {
        const variable = record(rawVariable)
        const name = nonEmptyString(variable?.name)
        const value = typeof variable?.value === 'string' ? variable.value : undefined
        if (name === undefined || value === undefined) continue
        variables.push(debugVariableValue(
          name,
          value,
          nonEmptyString(variable?.type),
          integer(variable?.variablesReference) ?? 0,
        ))
        variableCount += 1
      }
      scopes.push({ name: compactDebugText(nonEmptyString(scope.name) ?? 'Locals', 120), variables })
      if (variableCount >= 24) break
    }

    return {
      session: this.sessions.snapshot(snapshot.sessionId) ?? snapshot,
      frames,
      scopes,
      truncated: rawFrames.length > frames.length || variableCount >= 24,
    }
  }

  private async listBreakpoints(): Promise<DebugBreakpointResult> {
    const session = this.sessions.session()
    const views: DebugBreakpointView[] = []
    for (const breakpoint of this.ownedBreakpoints.values()) {
      let verified: boolean | undefined
      if (session !== undefined) {
        try {
          const protocolBreakpoint = record(await session.getDebugProtocolBreakpoint(breakpoint))
          verified = typeof protocolBreakpoint?.verified === 'boolean' ? protocolBreakpoint.verified : undefined
        } catch {
          verified = undefined
        }
      }
      views.push({
        id: breakpoint.id,
        path: relativePath(this.workspace.uri.fsPath, breakpoint.location.uri.fsPath),
        line: breakpoint.location.range.start.line + 1,
        ...(verified === undefined ? {} : { verified }),
      })
    }
    return { breakpoints: views }
  }

  private async threadId(session: vscode.DebugSession, snapshot: DebugSessionSnapshot): Promise<number> {
    if (snapshot.currentThreadId !== undefined) return snapshot.currentThreadId
    const response = record(await session.customRequest('threads'))
    const threads = Array.isArray(response?.threads) ? response.threads : []
    const threadId = integer(record(threads[0])?.id)
    if (threadId === undefined) throw new Error('The debug adapter did not report an available thread.')
    return threadId
  }

  dispose(): void {
    this.breakpointChanges.dispose()
    if (this.ownedBreakpoints.size > 0) vscode.debug.removeBreakpoints([...this.ownedBreakpoints.values()])
    this.ownedBreakpoints.clear()
  }
}
