import * as vscode from 'vscode'
import { existingRuntimeUrl, type RuntimeTarget } from './runtime-target.js'

interface RuntimePickerHost {
  readonly cwd: string
  readonly runtimeOwnership: 'external' | 'managed' | undefined
  assertCanSelectRuntime(): void
  selectRuntime(target: RuntimeTarget): Promise<void>
}

async function confirmSwitch(host: RuntimePickerHost): Promise<boolean> {
  host.assertCanSelectRuntime()
  if (host.runtimeOwnership !== 'managed') return true
  return await vscode.window.showWarningMessage(
    'Switching runtimes will stop the extension-managed DSH process and its background jobs.',
    { modal: true }, 'Switch Runtime',
  ) === 'Switch Runtime'
}

/** Credentials only enter a native password box, never a Webview message or setting. */
export async function pickExistingRuntime(host: RuntimePickerHost): Promise<void> {
  host.assertCanSelectRuntime()
  const checkDebugging = (): void => {
    if (vscode.workspace.getConfiguration('deepseekHarness', vscode.Uri.file(host.cwd)).get<boolean>('autonomousDebugging', false)) {
      throw new Error('Autonomous debugging requires a managed runtime. Disable it before connecting to an existing DSH runtime.')
    }
  }
  checkDebugging()
  const value = await vscode.window.showInputBox({
    title: 'Connect to Existing DeepSeek Harness Runtime',
    prompt: 'Paste the full launch URL printed by dsh web. It is kept in memory for this connection only.',
    placeHolder: 'http://127.0.0.1:3080/?token=…',
    password: true,
    ignoreFocusOut: true,
    validateInput: input => {
      try { existingRuntimeUrl(input); return undefined }
      catch (error) { return error instanceof Error ? error.message : 'Invalid DSH launch URL.' }
    },
  })
  if (value === undefined) return
  const launchUrl = existingRuntimeUrl(value)
  if (!await confirmSwitch(host)) return
  checkDebugging()
  await host.selectRuntime({ kind: 'external', launchUrl })
}

export async function pickManagedRuntime(host: RuntimePickerHost): Promise<void> {
  if (!await confirmSwitch(host)) return
  await host.selectRuntime({ kind: 'managed' })
}
