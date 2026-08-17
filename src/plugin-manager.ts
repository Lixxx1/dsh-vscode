import { spawn } from 'node:child_process'
import * as vscode from 'vscode'
import { resolveLaunch } from './launch.js'
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

const CATALOG_CACHE_KEY = 'deepseekHarness.communityRuntimePlugins'
const MAX_REGISTRY_BYTES = 5 * 1024 * 1024

interface CatalogCache {
  fetchedAt: number
  plugins: CommunityRuntimePlugin[]
}

interface PluginController {
  readonly cwd: string
  readonly state: {
    phase: 'loading' | 'ready' | 'error'
    statusText: string
    running: boolean
  }
  pluginInventory(): Promise<PluginInventorySnapshot>
  restart(): Promise<void>
}

type PluginPick = vscode.QuickPickItem & (
  | { action: 'install' }
  | { action: 'browse' }
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

  private async requireIdle(): Promise<boolean> {
    if (!this.controller.state.running) return true
    await vscode.window.showWarningMessage('Wait for the current DeepSeek task to finish before changing runtime plugins.')
    return false
  }

  private async restartAfterChange(successMessage: string): Promise<void> {
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
        child.kill('SIGTERM')
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
