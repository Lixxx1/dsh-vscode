import * as vscode from 'vscode'
import {
  initialDebugSessionState,
  reduceDebugAdapterMessage,
  type DebugSessionPhase,
  type DebugSessionState,
} from './debug-state.js'

interface OwnedDebugSession {
  readonly session: vscode.DebugSession
  state: DebugSessionState
}

export interface DebugSessionSnapshot extends DebugSessionState {
  readonly sessionId: string
  readonly name: string
  readonly type: string
}

function workspaceKey(folder: vscode.WorkspaceFolder | undefined): string | undefined {
  return folder?.uri.toString(true)
}

/** Tracks the single agent-owned debug launch without taking over user sessions. */
export class DebugSessionManager implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = []
  private readonly changes = new vscode.EventEmitter<DebugSessionSnapshot>()
  private readonly owned = new Map<string, OwnedDebugSession>()
  private pendingWorkspace: string | undefined

  readonly onDidChangeState = this.changes.event

  constructor() {
    this.disposables.push(
      vscode.debug.registerDebugAdapterTrackerFactory('*', {
        createDebugAdapterTracker: session => ({
          onWillReceiveMessage: message => { this.acceptMessage(session, message) },
          onDidSendMessage: message => { this.acceptMessage(session, message) },
        }),
      }),
      vscode.debug.onDidStartDebugSession(session => { this.acceptStartedSession(session) }),
      vscode.debug.onDidTerminateDebugSession(session => { this.acceptTerminatedSession(session) }),
    )
  }

  beginLaunch(folder: vscode.WorkspaceFolder): void {
    if (this.pendingWorkspace !== undefined) throw new Error('A DeepSeek debug launch is already starting.')
    if (this.preferredSession() !== undefined) throw new Error('Stop the current DeepSeek debug session before starting another one.')
    for (const [sessionId, owned] of this.owned) {
      if (owned.state.phase === 'terminated') this.owned.delete(sessionId)
    }
    this.pendingWorkspace = workspaceKey(folder)
  }

  completeLaunch(started: boolean): DebugSessionSnapshot | undefined {
    this.pendingWorkspace = undefined
    if (!started) return undefined
    return this.snapshot()
  }

  cancelLaunch(): void {
    this.pendingWorkspace = undefined
  }

  session(sessionId?: string): vscode.DebugSession | undefined {
    return sessionId === undefined ? this.preferredSession()?.session : this.owned.get(sessionId)?.session
  }

  snapshot(sessionId?: string): DebugSessionSnapshot | undefined {
    const owned = sessionId === undefined ? this.preferredSession() : this.owned.get(sessionId)
    if (owned === undefined) return undefined
    return {
      sessionId: owned.session.id,
      name: owned.session.name,
      type: owned.session.type,
      ...owned.state,
    }
  }

  snapshots(): DebugSessionSnapshot[] {
    return [...this.owned.values()]
      .filter(item => item.state.phase !== 'terminated')
      .map(item => ({ sessionId: item.session.id, name: item.session.name, type: item.session.type, ...item.state }))
  }

  async waitFor(
    sessionId: string,
    phases: readonly DebugSessionPhase[],
    timeoutMs: number,
  ): Promise<DebugSessionSnapshot> {
    const current = this.snapshot(sessionId)
    if (current === undefined) throw new Error('The DeepSeek debug session is no longer available.')
    if (phases.includes(current.phase)) return current

    return await new Promise<DebugSessionSnapshot>(resolve => {
      let settled = false
      const finish = (snapshot: DebugSessionSnapshot): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        subscription.dispose()
        resolve(snapshot)
      }
      const subscription = this.onDidChangeState(snapshot => {
        if (snapshot.sessionId === sessionId && phases.includes(snapshot.phase)) finish(snapshot)
      })
      const timer = setTimeout(() => {
        const latest = this.snapshot(sessionId)
        if (latest !== undefined) finish(latest)
        else finish({ ...current, phase: 'terminated', threads: {} })
      }, timeoutMs)
    })
  }

  private acceptStartedSession(session: vscode.DebugSession): void {
    const parentOwned = session.parentSession !== undefined && this.owned.has(session.parentSession.id)
    const pendingMatch = this.pendingWorkspace !== undefined && workspaceKey(session.workspaceFolder) === this.pendingWorkspace
    if (!parentOwned && !pendingMatch) return
    this.ensureOwned(session)
  }

  private acceptTerminatedSession(session: vscode.DebugSession): void {
    const owned = this.owned.get(session.id)
    if (owned === undefined) return
    owned.state = { phase: 'terminated', stopEpoch: owned.state.stopEpoch, threads: {} }
    this.publish(owned)
  }

  private acceptMessage(session: vscode.DebugSession, message: unknown): void {
    const parentOwned = session.parentSession !== undefined && this.owned.has(session.parentSession.id)
    const pendingMatch = this.pendingWorkspace !== undefined && workspaceKey(session.workspaceFolder) === this.pendingWorkspace
    if (!this.owned.has(session.id) && !parentOwned && !pendingMatch) return
    const owned = this.ensureOwned(session)
    const next = reduceDebugAdapterMessage(owned.state, message)
    if (next === owned.state) return
    owned.state = next
    this.publish(owned)
  }

  private ensureOwned(session: vscode.DebugSession): OwnedDebugSession {
    const existing = this.owned.get(session.id)
    if (existing !== undefined) return existing
    const owned = { session, state: initialDebugSessionState() }
    this.owned.set(session.id, owned)
    this.publish(owned)
    return owned
  }

  private preferredSession(): OwnedDebugSession | undefined {
    const active = vscode.debug.activeDebugSession
    if (active !== undefined) {
      const owned = this.owned.get(active.id)
      if (owned !== undefined && owned.state.phase !== 'terminated') return owned
    }
    return [...this.owned.values()].find(item => item.state.phase === 'stopped')
      ?? [...this.owned.values()].find(item => item.state.phase !== 'terminated')
  }

  private publish(owned: OwnedDebugSession): void {
    this.changes.fire({
      sessionId: owned.session.id,
      name: owned.session.name,
      type: owned.session.type,
      ...owned.state,
    })
  }

  dispose(): void {
    for (const disposable of this.disposables.splice(0)) disposable.dispose()
    this.changes.dispose()
    this.owned.clear()
    this.pendingWorkspace = undefined
  }
}
