import * as vscode from 'vscode'
import { DEEPSEEK_API_KEY_SECRET, normalizeDeepSeekApiKey } from './credentials.js'
import {
  isCurrentRuntimeTarget,
  restartAfterRuntimeChange,
  runtimeChangeTarget,
  type RuntimeChangeController,
} from './runtime-change.js'

interface ConfigurationController extends RuntimeChangeController {
  start(): Promise<void>
}

export async function configureApiKey(
  controller: ConfigurationController, secrets: vscode.SecretStorage, output: vscode.OutputChannel,
): Promise<void> {
  if (controller.isDisposed) return
  if (controller.runtimeOwnership === undefined && controller.state.phase !== 'loading') await controller.start()
  if (controller.isDisposed) return
  if (controller.runtimeOwnership === 'external') {
    await vscode.window.showInformationMessage('This sidebar is using an external DeepSeek Harness runtime. Configure its API key where that process is started.')
    return
  }
  const target = runtimeChangeTarget(controller)
  const value = await vscode.window.showInputBox({
    title: 'Configure DeepSeek API Key',
    prompt: 'Paste the key here. It is stored in VS Code SecretStorage and passed only to the official DSH child process.',
    placeHolder: 'sk-…', password: true, ignoreFocusOut: true,
    validateInput: candidate => {
      try { normalizeDeepSeekApiKey(candidate); return undefined }
      catch (error) { return error instanceof Error ? error.message : String(error) }
    },
  })
  if (value === undefined || controller.isDisposed) return
  if (!isCurrentRuntimeTarget(controller, target)) {
    await vscode.window.showWarningMessage('The runtime connection changed. No API key was stored; reopen Configure DeepSeek API Key for the intended runtime.')
    return
  }
  await secrets.store(DEEPSEEK_API_KEY_SECRET, normalizeDeepSeekApiKey(value))
  output.appendLine('[credentials] DeepSeek API key stored in VS Code SecretStorage.')
  await restartAfterRuntimeChange(controller, target, 'DeepSeek API key configured')
}

export async function clearApiKey(
  controller: ConfigurationController, secrets: vscode.SecretStorage, output: vscode.OutputChannel,
): Promise<void> {
  if (controller.isDisposed) return
  const target = runtimeChangeTarget(controller)
  const choice = await vscode.window.showWarningMessage(
    'Remove the DeepSeek API key stored by this extension?', { modal: true }, 'Remove',
  )
  if (choice !== 'Remove' || controller.isDisposed) return
  await secrets.delete(DEEPSEEK_API_KEY_SECRET)
  output.appendLine('[credentials] DeepSeek API key removed from VS Code SecretStorage.')
  if (controller.isDisposed) return
  if (isCurrentRuntimeTarget(controller, target) && controller.runtimeOwnership === 'external') {
    await vscode.window.showInformationMessage('Stored DeepSeek API key removed. The reused external DSH keeps its own credentials.')
    return
  }
  await restartAfterRuntimeChange(controller, target, 'Stored DeepSeek API key removed')
}

export function watchDebugConfiguration(
  controller: RuntimeChangeController, workspace: vscode.Uri, output: vscode.OutputChannel,
): vscode.Disposable {
  let timer: NodeJS.Timeout | undefined
  let revision = 0
  let disposed = false
  const listener = vscode.workspace.onDidChangeConfiguration(event => {
    const resource = controller.cwd === '' ? workspace : vscode.Uri.file(controller.cwd)
    if (!event.affectsConfiguration('deepseekHarness.autonomousDebugging', resource)) return
    const enabled = vscode.workspace.getConfiguration('deepseekHarness', resource).get<boolean>('autonomousDebugging', false)
    const target = runtimeChangeTarget(controller)
    const request = ++revision
    if (timer !== undefined) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = undefined
      if (disposed || controller.isDisposed || request !== revision) return
      const message = `VS Code debugging ${enabled ? 'enabled' : 'disabled'}`
      output.appendLine(`[debug] ${message}; checking whether DSH can restart to apply the setting.`)
      if (target.identity === undefined && isCurrentRuntimeTarget(controller, target)) {
        void vscode.window.showInformationMessage(`${message}. The setting will apply the next time a managed DSH runtime starts.`)
        return
      }
      if (isCurrentRuntimeTarget(controller, target) && controller.runtimeOwnership === 'external') {
        void vscode.window.showInformationMessage(`${message}. VS Code debugging integration applies to managed DSH runtimes; the connected external runtime was not changed.`)
        return
      }
      void restartAfterRuntimeChange(controller, target, message, () => !disposed && request === revision).catch(error => {
        if (disposed || controller.isDisposed || request !== revision) return
        const detail = error instanceof Error ? error.message : String(error)
        output.appendLine(`[debug] Could not apply the setting: ${detail}`)
        void vscode.window.showErrorMessage(detail)
      })
    }, 200)
  })
  return { dispose: () => { disposed = true; ++revision; if (timer !== undefined) clearTimeout(timer); listener.dispose() } }
}
