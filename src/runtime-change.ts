import * as vscode from 'vscode'

export interface RuntimeChangeController {
  readonly cwd: string
  readonly isDisposed: boolean
  readonly runtimeOwnership: 'external' | 'managed' | undefined
  readonly runtimeIdentity: object | undefined
  readonly hasRunningTasks: boolean
  readonly state: { phase: 'loading' | 'ready' | 'error'; statusText: string }
  /** False when another connection operation superseded this restart. */
  restart(): Promise<boolean>
}

export interface RuntimeChangeTarget {
  readonly identity: object | undefined
  readonly cwd: string
}

export function runtimeChangeTarget(controller: RuntimeChangeController): RuntimeChangeTarget {
  return { identity: controller.runtimeIdentity, cwd: controller.cwd }
}

export function isCurrentRuntimeTarget(controller: RuntimeChangeController, target: RuntimeChangeTarget): boolean {
  return !controller.isDisposed && target.identity === controller.runtimeIdentity && target.cwd === controller.cwd
}

/** For automatic restarts after a saved change, not the explicit Restart command. */
export async function restartAfterRuntimeChange(
  controller: RuntimeChangeController,
  target: RuntimeChangeTarget,
  successMessage: string,
  isCurrent: () => boolean = () => true,
): Promise<void> {
  if (controller.isDisposed || !isCurrent()) return
  if (!isCurrentRuntimeTarget(controller, target) || controller.state.phase === 'loading'
    || (controller.runtimeOwnership !== undefined && controller.state.phase !== 'ready')) {
    await vscode.window.showWarningMessage(`${successMessage}. The runtime connection changed; no runtime was restarted. Restart the intended runtime when ready to apply the change.`)
    return
  }
  if (controller.runtimeOwnership === 'external') {
    await vscode.window.showWarningMessage(`${successMessage}. Restart the external DeepSeek Harness process to apply this change, then reconnect from VS Code.`)
    return
  }
  if (controller.hasRunningTasks) {
    await vscode.window.showWarningMessage(`${successMessage}. DeepSeek tasks are still running, so the runtime was not restarted. Restart it after those tasks and Background Jobs finish to apply the change.`)
    return
  }
  // No asynchronous dialog between the last activity check and starting the restart.
  if (!await controller.restart() || controller.isDisposed || !isCurrent()) return
  if (controller.state.phase === 'error') {
    throw new Error(`${successMessage}, but DSH could not restart: ${controller.state.statusText}`)
  }
  if (controller.state.phase === 'ready') {
    await vscode.window.showInformationMessage(`${successMessage}. DeepSeek Harness restarted.`)
  }
}
