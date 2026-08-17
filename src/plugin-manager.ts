import { spawn } from 'node:child_process'
import * as vscode from 'vscode'
import { resolveLaunch } from './launch.js'
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

const COMMUNITY_PLUGINS = vscode.Uri.parse('https://github.com/awesome-dsh-plugin/awesome-dsh-plugin')

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
        await vscode.env.openExternal(COMMUNITY_PLUGINS)
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
        label: '$(globe) Browse community plugins',
        detail: 'Open the community catalog; choose runtime plugins rather than Web UI themes or panels',
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

    await this.runOfficialPluginCommand(['add', spec], `Installing ${spec}`)
    const installed = readInstalledPlugins(resolveDshHome())
    const added = findAddedPlugin(before, installed)
    if (added !== undefined && !added.bundle) {
      await vscode.window.showWarningMessage(
        `${added.name} installed, but it does not declare a DSH bundle and was not activated.`,
      )
    }
    await this.restartAfterChange(`Installed ${added?.name ?? spec}`)
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
