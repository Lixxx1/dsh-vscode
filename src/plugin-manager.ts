import { spawn } from 'node:child_process'
import * as vscode from 'vscode'
import { resolveLaunch } from './launch.js'
import { terminateProcessTree } from './process-tree.js'
import {
  COMMUNITY_REGISTRY_URL,
  parseCommunityRuntimePlugins,
  type CommunityRuntimePlugin,
} from './plugin-catalog.js'
import {
  findAddedPlugin,
  installedPluginStatus,
  normalizePluginSpec,
  readInstalledPlugins,
  resolveDshHome,
  type InstalledPlugin,
  type InstalledPluginStatus,
  type PluginInventorySnapshot,
} from './plugin-profile.js'
import {
  hasSettingsOverrides,
  parseRuntimeSetting,
  runtimeSettingFields,
  settingConstantOptions,
  type RuntimeSettingField,
  type SettingsDescription,
  type SettingsMutation,
  type SettingsNamespace,
} from './runtime-settings.js'

const CATALOG_CACHE_KEY = 'deepseekHarness.communityRuntimePlugins'
const MAX_REGISTRY_BYTES = 5 * 1024 * 1024

interface CatalogCache {
  fetchedAt: number
  plugins: CommunityRuntimePlugin[]
}

interface PluginController {
  readonly cwd: string
  readonly runtimeOwnership: 'external' | 'managed' | undefined
  readonly state: {
    phase: 'loading' | 'ready' | 'error'
    statusText: string
    running: boolean
  }
  pluginInventory(): Promise<PluginInventorySnapshot>
  settings(): Promise<SettingsDescription>
  mutateSettings(ns: string, ops: SettingsMutation[], expectedRevision: number): Promise<SettingsNamespace>
  restart(): Promise<void>
}

type PluginPick = vscode.QuickPickItem & (
  | { action: 'install' }
  | { action: 'browse' }
  | { action: 'configure' }
  | { action: 'refresh' }
  | { action: 'plugin'; plugin: InstalledPlugin }
  | { action: 'empty' }
)

const STATUS_LABELS: Record<InstalledPluginStatus, string> = {
  active: 'Active',
  failed: 'Failed',
  disabled: 'Disabled',
  loading: 'Loading',
  inactive: 'Inactive',
  unknown: 'Status unavailable',
}

const STATUS_ICONS: Record<InstalledPluginStatus, string> = {
  active: 'pass-filled',
  failed: 'error',
  disabled: 'circle-slash',
  loading: 'loading~spin',
  inactive: 'circle-outline',
  unknown: 'extensions',
}

/** Manage runtime-capability bundles through the official DSH profile CLI. */
export class DshPluginManager {
  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly controller: PluginController,
    private readonly output: vscode.OutputChannel,
  ) {}

  async show(): Promise<void> {
    while (true) {
      const plugins = readInstalledPlugins(resolveDshHome())
      const inventory = await this.tryInventory()
      const selected = await vscode.window.showQuickPick(this.items(plugins, inventory), {
        title: 'DeepSeek Harness Runtime Plugins',
        placeHolder: 'Tools, skills, MCP, memory, and agent hooks loaded by the DSH web profile',
        matchOnDescription: true,
        matchOnDetail: true,
      })
      if (selected === undefined || selected.action === 'empty') return
      if (selected.action === 'browse') {
        await this.browseCatalog()
        return
      }
      if (selected.action === 'configure') {
        await this.configureSettings()
        continue
      }
      if (selected.action === 'refresh') continue
      if (selected.action === 'install') {
        await this.install()
        continue
      }
      await this.pluginActions(selected.plugin)
    }
  }

  private items(
    plugins: readonly InstalledPlugin[],
    inventory: PluginInventorySnapshot | undefined,
  ): PluginPick[] {
    const items: PluginPick[] = [
      {
        action: 'install',
        label: '$(add) Install runtime plugin…',
        detail: 'Install an npm package, GitHub source, tarball, or local DSH bundle',
      },
      {
        action: 'browse',
        label: '$(search) Find community runtime plugins…',
        detail: 'Search tools, skills, MCP integrations, memory, and agent hooks; install with one click',
      },
      {
        action: 'configure',
        label: '$(settings-gear) Configure runtime settings…',
        detail: 'Edit settings namespaces registered by built-in and community DSH plugins',
      },
      {
        action: 'refresh',
        label: '$(refresh) Refresh',
        detail: 'Read the current web profile and Loader status again',
      },
      { action: 'empty', label: 'Installed for the DSH web profile', kind: vscode.QuickPickItemKind.Separator },
    ]

    if (plugins.length === 0) {
      items.push({
        action: 'empty',
        label: '$(info) No community runtime plugins installed',
        detail: 'The built-in DSH runtime remains available.',
      })
      return items
    }

    for (const plugin of plugins) {
      const status = plugin.bundle ? installedPluginStatus(plugin.name, inventory) : 'inactive'
      items.push({
        action: 'plugin',
        plugin,
        label: `$(${STATUS_ICONS[status]}) ${plugin.name}`,
        description: plugin.bundle ? STATUS_LABELS[status] : 'Not a DSH bundle',
        detail: `${plugin.spec} · Applies to every project using the web profile`,
      })
    }
    return items
  }

  private async tryInventory(): Promise<PluginInventorySnapshot | undefined> {
    if (this.controller.state.phase !== 'ready') return undefined
    try {
      return await this.controller.pluginInventory()
    } catch (error) {
      this.output.appendLine(`[plugins] Runtime inventory unavailable: ${this.message(error)}`)
      return undefined
    }
  }

  private async install(): Promise<void> {
    if (!await this.requireIdle()) return
    const before = readInstalledPlugins(resolveDshHome())
    const input = await vscode.window.showInputBox({
      title: 'Install DSH Runtime Plugin',
      prompt: 'Enter an npm package, GitHub source, tarball, or local DSH plugin path.',
      placeHolder: '@scope/plugin or github:owner/repository',
      ignoreFocusOut: true,
      validateInput: (value) => {
        try {
          normalizePluginSpec(value)
          return undefined
        } catch (error) {
          return this.message(error)
        }
      },
    })
    if (input === undefined) return
    const spec = normalizePluginSpec(input)
    const confirmed = await vscode.window.showWarningMessage(
      `Install ${spec}?`,
      {
        modal: true,
        detail: 'Third-party DSH plugins run with your user permissions and may access files, credentials, and the network. This changes the shared web profile for every VS Code project. Only install sources you trust.',
      },
      'Install',
    )
    if (confirmed !== 'Install') return
    await this.installConfirmed(spec, spec, before)
  }

  private async installConfirmed(
    spec: string,
    displayName: string,
    before: readonly InstalledPlugin[] = readInstalledPlugins(resolveDshHome()),
  ): Promise<void> {
    await this.runOfficialPluginCommand(['add', spec], `Installing ${displayName}`)
    const installed = readInstalledPlugins(resolveDshHome())
    const added = findAddedPlugin(before, installed)
    if (added !== undefined && !added.bundle) {
      await vscode.window.showWarningMessage(
        `${added.name} installed, but it does not declare a DSH bundle and was not activated.`,
      )
    }
    await this.restartAfterChange(`Installed ${added?.name ?? spec}`)
  }

  private async browseCatalog(): Promise<void> {
    const plugins = await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: 'Loading DSH community runtime plugins…',
    }, async () => this.loadCatalog())
    const installed = new Set(readInstalledPlugins(resolveDshHome()).map(plugin => plugin.name))
    const selected = await vscode.window.showQuickPick(plugins.map(plugin => {
      const alreadyInstalled = installed.has(plugin.npm ?? plugin.name)
      const stars = plugin.stars === undefined ? '' : ` · ★ ${String(plugin.stars)}`
      return {
        label: `${alreadyInstalled ? '$(pass-filled) ' : ''}${plugin.name}`,
        description: `${plugin.categoryLabel}${stars}`,
        detail: `${plugin.description} · ${plugin.owner}`,
        plugin,
        alreadyInstalled,
      }
    }), {
      title: 'Community Runtime Plugins',
      placeHolder: 'Search tools, skills, MCP, memory, integrations, and agent hooks',
      matchOnDescription: true,
      matchOnDetail: true,
    })
    if (selected === undefined) return
    const actions = selected.alreadyInstalled
      ? [{ label: '$(github) Open on GitHub', action: 'open' as const }]
      : [
          { label: '$(cloud-download) Install', action: 'install' as const },
          { label: '$(github) Open on GitHub', action: 'open' as const },
        ]
    const action = await vscode.window.showQuickPick(actions, {
      title: `${selected.plugin.owner}/${selected.plugin.name}`,
      placeHolder: selected.alreadyInstalled ? 'Already installed in the DSH web profile' : selected.plugin.description,
    })
    if (action?.action === 'open') {
      await vscode.env.openExternal(vscode.Uri.parse(selected.plugin.url))
      return
    }
    if (action?.action !== 'install' || !await this.requireIdle()) return
    const confirmed = await vscode.window.showWarningMessage(
      `Install ${selected.plugin.name}?`,
      {
        modal: true,
        detail: `${selected.plugin.description}\n\nSource: ${selected.plugin.url}\nInstall: ${selected.plugin.installSpec}\n\nThird-party DSH plugins run with your user permissions and may access files, credentials, and the network. The community catalog is not a security review.`,
      },
      'Install',
    )
    if (confirmed !== 'Install') return
    await this.installConfirmed(selected.plugin.installSpec, selected.plugin.name)
  }

  private async loadCatalog(): Promise<CommunityRuntimePlugin[]> {
    try {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 15_000)
      let response: Response
      try {
        response = await fetch(COMMUNITY_REGISTRY_URL, {
          headers: { accept: 'application/json' },
          signal: controller.signal,
        })
      } finally {
        clearTimeout(timeout)
      }
      if (!response.ok) throw new Error(`Community registry returned HTTP ${String(response.status)}.`)
      const source = await response.text()
      if (Buffer.byteLength(source, 'utf8') > MAX_REGISTRY_BYTES) {
        throw new Error('Community registry response is unexpectedly large.')
      }
      const plugins = parseCommunityRuntimePlugins(JSON.parse(source) as unknown, { locale: vscode.env.language })
      if (plugins.length === 0) throw new Error('Community registry contains no compatible runtime plugins.')
      await this.context.globalState.update(CATALOG_CACHE_KEY, { fetchedAt: Date.now(), plugins } satisfies CatalogCache)
      return plugins
    } catch (error) {
      const cached = this.context.globalState.get<CatalogCache>(CATALOG_CACHE_KEY)
      if (cached !== undefined && Array.isArray(cached.plugins) && cached.plugins.length > 0) {
        this.output.appendLine(`[plugins] Community registry unavailable; using cache from ${new Date(cached.fetchedAt).toISOString()}: ${this.message(error)}`)
        return cached.plugins
      }
      throw new Error(`Could not load community runtime plugins: ${this.message(error)}`)
    }
  }

  private async pluginActions(plugin: InstalledPlugin): Promise<void> {
    const selected = await vscode.window.showQuickPick([
      {
        label: '$(trash) Remove plugin',
        description: plugin.name,
        detail: 'Remove it from the shared DSH web profile and restart the runtime',
        action: 'remove' as const,
      },
    ], {
      title: plugin.name,
      placeHolder: plugin.spec,
    })
    if (selected?.action !== 'remove' || !await this.requireIdle()) return
    const confirmed = await vscode.window.showWarningMessage(
      `Remove ${plugin.name} from the DSH web profile?`,
      { modal: true, detail: 'The change applies to every VS Code project using this profile.' },
      'Remove',
    )
    if (confirmed !== 'Remove') return
    await this.runOfficialPluginCommand(['remove', plugin.name], `Removing ${plugin.name}`)
    await this.restartAfterChange(`Removed ${plugin.name}`)
  }

  private async configureSettings(): Promise<void> {
    if (this.controller.state.phase !== 'ready') {
      await vscode.window.showWarningMessage('Start DeepSeek Harness before configuring runtime settings.')
      return
    }
    let description = await this.controller.settings()
    if (!description.writable) {
      await vscode.window.showWarningMessage('The active DSH profile does not expose writable runtime settings.')
      return
    }
    while (true) {
      const selected = await vscode.window.showQuickPick(description.namespaces.map(namespace => ({
        label: `$(settings-gear) ${namespace.ns}`,
        description: hasSettingsOverrides(namespace) ? 'Customized' : 'Default',
        detail: `${namespace.applies === 'restart' ? 'Requires a runtime restart' : 'Applies immediately'} · ${String(runtimeSettingFields(namespace).length)} settings`,
        namespace,
      })), {
        title: 'DeepSeek Harness Runtime Settings',
        placeHolder: 'Choose a settings namespace registered by DSH or a runtime plugin',
        matchOnDescription: true,
        matchOnDetail: true,
      })
      if (selected === undefined) return
      const changed = await this.configureNamespace(selected.namespace)
      if (!changed) continue
      if (selected.namespace.applies === 'restart') {
        await this.restartAfterChange(`${selected.namespace.ns} updated`)
        return
      }
      await vscode.window.showInformationMessage(`${selected.namespace.ns} updated.`)
      description = await this.controller.settings()
    }
  }

  private async configureNamespace(namespace: SettingsNamespace): Promise<boolean> {
    if (namespace.applies === 'restart' && !await this.requireIdle()) return false
    const fields = runtimeSettingFields(namespace)
    type FieldPick = vscode.QuickPickItem & (
      | { action: 'field'; field: RuntimeSettingField }
      | { action: 'reset-all' }
    )
    const items: FieldPick[] = fields.map(field => ({
      action: 'field',
      field,
      label: field.path.join('.'),
      description: this.settingSummary(field),
      detail: `${field.overridden ? 'Customized' : 'Inherited'}${field.node.meta?.description === undefined ? '' : ` · ${field.node.meta.description}`}`,
    }))
    if (hasSettingsOverrides(namespace)) {
      items.unshift({
        action: 'reset-all',
        label: '$(discard) Reset all overrides',
        description: namespace.ns,
        detail: 'Use the values supplied by DSH and its plugins',
      })
    }
    const selected = await vscode.window.showQuickPick(items, {
      title: namespace.ns,
      placeHolder: namespace.applies === 'restart' ? 'Changes restart the DSH runtime' : 'Changes apply immediately',
      matchOnDescription: true,
      matchOnDetail: true,
    })
    if (selected === undefined) return false
    if (selected.action === 'reset-all') {
      const resets: SettingsMutation[] = fields
        .filter(field => field.overridden)
        .map(field => ({ op: 'unset', path: field.path }))
      if (resets.length === 0) return false
      await this.controller.mutateSettings(namespace.ns, resets, namespace.revision)
      return true
    }
    const mutation = await this.editSetting(namespace, selected.field)
    if (mutation === undefined) return false
    await this.controller.mutateSettings(namespace.ns, [mutation], namespace.revision)
    return true
  }

  private async editSetting(
    namespace: SettingsNamespace,
    field: RuntimeSettingField,
  ): Promise<SettingsMutation | undefined> {
    if (field.secretSet !== undefined) return this.editSecret(field)
    const options = settingConstantOptions(field, namespace.schema)
    if (options !== undefined) {
      type ValuePick = vscode.QuickPickItem & ({ value: unknown } | { reset: true })
      const choices: ValuePick[] = options.map(value => ({
        label: this.settingValue(value),
        ...(Object.is(value, field.value) ? { description: 'Current' } : {}),
        value,
      }))
      const choiceItems: ValuePick[] = [
        ...choices,
        ...(field.overridden ? [{
          label: '$(discard) Use inherited value',
          description: this.settingValue(field.inherited),
          reset: true as const,
        }] : []),
      ]
      const selected = await vscode.window.showQuickPick(choiceItems, {
        title: field.path.join('.'), placeHolder: 'Choose a value',
      })
      if (selected === undefined) return undefined
      if ('reset' in selected) return { op: 'unset', path: field.path }
      return { op: 'set', path: field.path, value: selected.value }
    }
    const action = await vscode.window.showQuickPick([
      { label: '$(edit) Change value', action: 'edit' as const },
      ...(field.overridden ? [{
        label: '$(discard) Use inherited value',
        description: this.settingValue(field.inherited),
        action: 'reset' as const,
      }] : []),
    ], { title: field.path.join('.'), placeHolder: this.settingSummary(field) })
    if (action === undefined) return undefined
    if (action.action === 'reset') return { op: 'unset', path: field.path }
    const input = await vscode.window.showInputBox({
      title: field.path.join('.'),
      prompt: field.node.type === 'string' ? 'Enter a string value.' : 'Enter the new value as JSON.',
      value: field.value === undefined ? '' : field.node.type === 'string' ? String(field.value) : JSON.stringify(field.value),
      ignoreFocusOut: true,
      validateInput: source => {
        try {
          parseRuntimeSetting(field, source)
          return undefined
        } catch (error) {
          return this.message(error)
        }
      },
    })
    if (input === undefined) return undefined
    return { op: 'set', path: field.path, value: parseRuntimeSetting(field, input) }
  }

  private async editSecret(field: RuntimeSettingField): Promise<SettingsMutation | undefined> {
    if (field.secretSet) {
      const action = await vscode.window.showQuickPick([
        { label: '$(key) Replace secret', action: 'replace' as const },
        { label: '$(trash) Clear secret', action: 'clear' as const },
      ], { title: field.path.join('.'), placeHolder: 'The current secret value is never exposed by DSH' })
      if (action === undefined) return undefined
      if (action.action === 'clear') return { op: 'unset', path: field.path }
    }
    const value = await vscode.window.showInputBox({
      title: field.path.join('.'),
      prompt: 'Enter the secret. DSH stores it without returning the value to this extension.',
      password: true,
      ignoreFocusOut: true,
      validateInput: source => source.length === 0 ? 'Secret cannot be empty.' : undefined,
    })
    return value === undefined ? undefined : { op: 'set', path: field.path, value }
  }

  private settingSummary(field: RuntimeSettingField): string {
    if (field.secretSet !== undefined) return field.secretSet ? 'Configured secret' : 'Secret not set'
    return this.settingValue(field.value)
  }

  private settingValue(value: unknown): string {
    if (value === undefined) return 'Not set'
    if (typeof value === 'string') return value === '' ? 'Empty string' : value
    const rendered = JSON.stringify(value)
    return rendered === undefined ? String(value) : rendered.length > 80 ? `${rendered.slice(0, 77)}…` : rendered
  }

  private async requireIdle(): Promise<boolean> {
    if (!this.controller.state.running) return true
    await vscode.window.showWarningMessage('Wait for the current DeepSeek task to finish before changing runtime plugins.')
    return false
  }

  private async restartAfterChange(successMessage: string): Promise<void> {
    if (this.controller.runtimeOwnership === 'external') {
      await vscode.window.showWarningMessage(
        `${successMessage}. Restart the external DeepSeek Harness process to apply this change, then reconnect from VS Code.`,
      )
      return
    }
    await this.controller.restart()
    if (this.controller.state.phase === 'error') {
      throw new Error(`${successMessage}, but DSH could not restart: ${this.controller.state.statusText}`)
    }
    await vscode.window.showInformationMessage(`${successMessage}. DeepSeek Harness restarted.`)
  }

  private async runOfficialPluginCommand(args: readonly string[], title: string): Promise<void> {
    const workspace = vscode.workspace.workspaceFolders?.[0]?.uri
    const config = vscode.workspace.getConfiguration('deepseekHarness', workspace)
    const executable = config.get<string>('executable', '')
    const launch = resolveLaunch(
      this.context.extensionUri.fsPath,
      executable,
      ['plugin', '--profile', 'web', ...args],
    )
    const cwd = this.controller.cwd || workspace?.fsPath || process.cwd()
    const rendered = [launch.command, ...launch.args].map(part => JSON.stringify(part)).join(' ')
    this.output.appendLine(`[plugins] cwd: ${cwd}`)
    this.output.appendLine(`[plugins] launch: ${rendered}`)

    await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title,
      cancellable: true,
    }, async (_progress, token) => new Promise<void>((resolvePromise, rejectPromise) => {
      let diagnostics = ''
      let cancelled = false
      let settled = false
      const child = spawn(launch.command, launch.args, {
        cwd,
        env: { ...process.env, NO_COLOR: '1', ...launch.env },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        windowsVerbatimArguments: launch.windowsVerbatimArguments,
      })
      const append = (chunk: Buffer | string): void => {
        const text = String(chunk)
        this.output.append(text)
        diagnostics = `${diagnostics}${text}`.slice(-16_000)
      }
      child.stdout.on('data', append)
      child.stderr.on('data', append)
      const cancellation = token.onCancellationRequested(() => {
        cancelled = true
        terminateProcessTree(child)
      })
      child.once('error', (error) => {
        if (settled) return
        settled = true
        cancellation.dispose()
        rejectPromise(error)
      })
      child.once('close', (code) => {
        if (settled) return
        settled = true
        cancellation.dispose()
        if (cancelled) {
          rejectPromise(new Error('Plugin operation cancelled.'))
          return
        }
        if (code === 0) {
          resolvePromise()
          return
        }
        if (/pnpm not found|ENOENT.*pnpm/i.test(diagnostics) || code === 127) {
          rejectPromise(new Error('DSH plugin management requires pnpm on PATH. Install or enable pnpm, then try again.'))
          return
        }
        rejectPromise(new Error(`The official DSH plugin command failed with code ${String(code)}. Open DeepSeek Harness output for details.`))
      })
    }))
  }

  private message(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
  }
}
