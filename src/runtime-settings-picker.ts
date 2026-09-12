import * as vscode from 'vscode'
import { RemoteRead } from './remote-read.js'
import { hasSettingsOverrides, runtimeSettingFields, type SettingsDescription, type SettingsNamespace } from './runtime-settings.js'

export interface RuntimeSettingsSource {
  settings(): Promise<SettingsDescription>
  readonly onDidChangeRuntimeSettings: vscode.Event<void>
}

/** Keep the open native namespace picker current without changing an in-progress field draft. */
export function pickRuntimeSettingsNamespace(source: RuntimeSettingsSource): Promise<SettingsNamespace | undefined> {
  const picker = vscode.window.createQuickPick<vscode.QuickPickItem & { namespace: SettingsNamespace }>()
  picker.title = 'DeepSeek Harness Runtime Settings'
  picker.placeholder = 'Choose a settings namespace registered by DSH or a runtime plugin'
  picker.matchOnDescription = picker.matchOnDetail = true
  const lifetime = new AbortController()
  const read = new RemoteRead(() => source.settings(), lifetime.signal)
  return new Promise((resolve, reject) => {
    const disposables: vscode.Disposable[] = []
    let generation = 0
    const finish = (namespace?: SettingsNamespace, error?: unknown): void => {
      if (lifetime.signal.aborted) return
      lifetime.abort()
      for (const disposable of disposables) disposable.dispose()
      picker.hide()
      picker.dispose()
      if (error !== undefined) reject(error)
      else resolve(namespace)
    }
    const refresh = async (): Promise<void> => {
      const request = ++generation
      read.invalidate()
      picker.busy = true
      try {
        const description = await read.read()
        if (lifetime.signal.aborted || request !== generation) return
        if (!description.writable) throw new Error('The active DSH profile does not expose writable runtime settings.')
        const active = picker.activeItems[0]?.namespace.ns
        picker.items = description.namespaces.map(namespace => ({
          label: `$(settings-gear) ${namespace.ns}`,
          description: hasSettingsOverrides(namespace) ? 'Customized' : 'Default',
          detail: `${namespace.applies === 'restart' ? 'Requires a runtime restart' : 'Applies immediately'} · ${String(runtimeSettingFields(namespace).length)} settings`,
          namespace,
        }))
        picker.selectedItems = []
        if (active !== undefined) picker.activeItems = picker.items.filter(item => item.namespace.ns === active)
      } catch (error) {
        if (!lifetime.signal.aborted && request === generation) finish(undefined, error)
      } finally {
        if (!lifetime.signal.aborted && request === generation) picker.busy = false
      }
    }
    disposables.push(
      picker.onDidHide(() => finish()),
      picker.onDidAccept(() => { if (!picker.busy) finish(picker.selectedItems[0]?.namespace) }),
      source.onDidChangeRuntimeSettings(() => { void refresh() }),
    )
    picker.show()
    void refresh()
  })
}
