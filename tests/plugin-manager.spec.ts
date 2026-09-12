import { beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'

const mocks = vi.hoisted(() => ({
  pick: vi.fn(), warning: vi.fn(), info: vi.fn(), input: vi.fn(), progress: vi.fn(), installed: vi.fn(), spawn: vi.fn(), namespace: vi.fn(),
}))
vi.mock('vscode', () => ({
  QuickPickItemKind: { Separator: -1 }, ProgressLocation: { Notification: 15 },
  window: { showQuickPick: mocks.pick, showWarningMessage: mocks.warning, showInformationMessage: mocks.info, showInputBox: mocks.input, withProgress: mocks.progress },
  workspace: { getWorkspaceFolder: () => undefined, getConfiguration: () => ({ get: () => '' }) },
  Uri: { file: (fsPath: string) => ({ fsPath }) },
}))
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }))
vi.mock('../src/runtime-settings-picker.js', () => ({ pickRuntimeSettingsNamespace: mocks.namespace }))
vi.mock('../src/launch.js', () => ({ resolveLaunch: () => ({ command: 'dsh', args: [], sourceCheckout: false }) }))
vi.mock('../src/plugin-profile.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/plugin-profile.js')>(), readInstalledPlugins: mocks.installed,
}))
import { DshPluginManager } from '../src/plugin-manager.js'

function harness(ownership: 'external' | 'managed' = 'managed') {
  const controller = {
    runtimeOwnership: ownership, cwd: '/workspace', state: { phase: 'ready', statusText: '', running: false },
    runtimeIdentity: {}, backgroundRunning: false, isDisposed: false,
    get hasRunningTasks() { return this.state.running || this.backgroundRunning },
    pluginInventory: vi.fn(async () => ({ entries: [], agentPresets: [{ id: 'coding', trust: 'system', isDefault: true,
      rows: [{ entryId: 'mcp', moduleName: '@deepseek-ai/dsh-mcp-client', enabled: true, fiberPhase: null }] }] })),
    restart: vi.fn(async () => true), mutateSettings: vi.fn(),
  }
  const manager = new DshPluginManager({ extensionUri: { fsPath: '/extension' } } as any, controller as any,
    { appendLine: vi.fn(), append: vi.fn() } as any)
  return { controller, manager }
}
function processResult(beforeClose = () => {}) {
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), pid: 123 })
  queueMicrotask(() => { beforeClose(); child.emit('close', 0) })
  return child
}
function chooseInstall() {
  mocks.pick.mockImplementationOnce(items => items.find((item: any) => item.action === 'install'))
  mocks.input.mockResolvedValue('@example/plugin')
  mocks.warning.mockResolvedValue('Install')
}
function chooseSettings(applies: 'live' | 'restart' = 'restart') {
  const namespace = { ns: 'example-plugin', revision: 1, applies, secrets: [],
    value: { limit: 1 }, base: { limit: 1 }, schema: { uid: 1, refs: {
      '1': { type: 'object', dict: { limit: 2 } }, '2': { type: 'number' },
    } } }
  mocks.namespace.mockResolvedValueOnce(namespace)
  mocks.pick.mockImplementationOnce(items => items.find((item: any) => item.action === 'configure'))
    .mockImplementationOnce(items => items.find((item: any) => item.action === 'field'))
    .mockImplementationOnce(items => items.find((item: any) => item.action === 'edit'))
  mocks.input.mockResolvedValueOnce('2')
  return namespace
}
beforeEach(() => {
  vi.resetAllMocks(); mocks.installed.mockReturnValue([])
  mocks.progress.mockImplementation((_options, operation) => operation({}, { onCancellationRequested: () => ({ dispose() {} }) }))
  mocks.spawn.mockImplementation(() => processResult())
})

describe('runtime plugin management', () => {
  it('does not open restart-required setting fields while a background task is running', async () => {
    const h = harness(); chooseSettings(); h.controller.backgroundRunning = true
    // No further picker is opened; the unused field/value choices must not drive show() again.
    mocks.pick.mockReset().mockImplementationOnce(items => items.find((item: any) => item.action === 'configure'))
    await h.manager.show()
    expect(h.controller.mutateSettings).not.toHaveBeenCalled()
    expect(h.controller.restart).not.toHaveBeenCalled()
    expect(mocks.warning).toHaveBeenCalledWith(expect.stringContaining('background conversations'))
  })

  it('does not interrupt a task that starts while a settings write is completing', async () => {
    const h = harness(); chooseSettings()
    h.controller.mutateSettings.mockImplementationOnce(async () => { h.controller.backgroundRunning = true })
    await h.manager.show()
    expect(h.controller.mutateSettings).toHaveBeenCalledTimes(1)
    expect(h.controller.restart).not.toHaveBeenCalled()
    expect(mocks.warning).toHaveBeenCalledWith(expect.stringContaining('example-plugin updated. DeepSeek tasks are still running'))
  })

  it('does not restart a replacement runtime when a settings write completes late', async () => {
    const h = harness(); chooseSettings()
    h.controller.mutateSettings.mockImplementationOnce(async () => { h.controller.runtimeIdentity = {} })
    await h.manager.show()
    expect(h.controller.restart).not.toHaveBeenCalled()
    expect(mocks.warning).toHaveBeenCalledWith(expect.stringContaining('no runtime was restarted'))
  })

  it('keeps live settings editable during background tasks without restarting', async () => {
    const h = harness(); chooseSettings('live'); h.controller.backgroundRunning = true
    await h.manager.show()
    expect(h.controller.mutateSettings).toHaveBeenCalledTimes(1)
    expect(h.controller.restart).not.toHaveBeenCalled()
    expect(mocks.info).toHaveBeenCalledWith('example-plugin updated.')
  })

  it('blocks installation while another conversation is running, without opening an input dialog', async () => {
    const h = harness(); h.controller.backgroundRunning = true
    chooseInstall()
    await h.manager.show()
    expect(mocks.warning).toHaveBeenCalledWith(expect.stringContaining('background conversations'))
    expect(mocks.input).not.toHaveBeenCalled()
    expect(mocks.spawn).not.toHaveBeenCalled()
  })

  it('blocks removal while a background conversation is running', async () => {
    const h = harness(); h.controller.backgroundRunning = true
    mocks.installed.mockReturnValue([{ name: '@example/plugin', spec: '1.0.0', bundle: true }])
    mocks.pick.mockImplementationOnce(items => items.find((item: any) => item.action === 'plugin'))
      .mockImplementationOnce(items => items.find((item: any) => item.action === 'remove'))
    await h.manager.show()
    expect(mocks.warning).toHaveBeenCalledWith(expect.stringContaining('background conversations'))
    expect(mocks.spawn).not.toHaveBeenCalled()
    expect(h.controller.restart).not.toHaveBeenCalled()
  })

  it('checks background tasks again after the install confirmation', async () => {
    const h = harness(); chooseInstall()
    mocks.warning.mockImplementationOnce(() => { h.controller.backgroundRunning = true; return 'Install' })
    await expect(h.manager.show()).rejects.toThrow('Plugin operation cancelled')
    expect(mocks.spawn).not.toHaveBeenCalled()
  })

  it('does not install while reconnecting', async () => {
    const h = harness(); h.controller.state.phase = 'loading'; chooseInstall()
    await h.manager.show()
    expect(mocks.warning).toHaveBeenCalledWith(expect.stringContaining('reconnect'))
    expect(mocks.spawn).not.toHaveBeenCalled()
  })

  it('defers the restart if a task begins while the plugin CLI is running', async () => {
    const h = harness(); chooseInstall()
    mocks.spawn.mockImplementationOnce(() => processResult(() => { h.controller.backgroundRunning = true }))
    await h.manager.show()
    expect(mocks.spawn).toHaveBeenCalledTimes(1)
    expect(h.controller.restart).not.toHaveBeenCalled()
    expect(mocks.warning).toHaveBeenCalledWith(expect.stringContaining('Installed @example/plugin. DeepSeek tasks are still running'))
    expect(mocks.info).not.toHaveBeenCalled()
  })

  it('does not restart a replacement managed runtime after installing into the original profile', async () => {
    const h = harness(); chooseInstall()
    mocks.spawn.mockImplementationOnce(() => processResult(() => { h.controller.runtimeIdentity = {} }))
    await h.manager.show()
    expect(h.controller.restart).not.toHaveBeenCalled()
    expect(mocks.warning).toHaveBeenCalledWith(expect.stringContaining('no runtime was restarted'))
  })

  it('does not start the CLI if a different managed runtime was selected before progress opens', async () => {
    const h = harness(); chooseInstall()
    mocks.progress.mockImplementationOnce((_options, operation) => { h.controller.runtimeIdentity = {}; return operation({}, {}) })
    await expect(h.manager.show()).rejects.toThrow('runtime changed')
    expect(mocks.spawn).not.toHaveBeenCalled()
  })

  it('does restart after an idle installation into the same runtime', async () => {
    const h = harness(); chooseInstall()
    await h.manager.show()
    expect(mocks.spawn).toHaveBeenCalledTimes(1)
    expect(h.controller.restart).toHaveBeenCalledTimes(1)
    expect(mocks.info).toHaveBeenCalledWith(expect.stringContaining('Installed @example/plugin. DeepSeek Harness restarted.'))
  })

  it('shows preset and global inventory with read-only rows and fetches again on refresh', async () => {
    const h = harness()
    mocks.pick.mockImplementationOnce(items => items.find((item: any) => item.action === 'inventory'))
      .mockImplementationOnce((items, options) => {
        expect(items.some((item: any) => item.description === 'Configured · not running')).toBe(true)
        expect(items.some((item: any) => item.label === 'Global runtime')).toBe(true)
        expect(options.placeHolder).toContain('does not confirm')
        expect(items.every((item: any) => item.action === undefined)).toBe(true)
        return items[0]
      }).mockResolvedValue(undefined)
    await h.manager.show()
    expect(h.controller.pluginInventory).toHaveBeenCalledTimes(4)
    expect(mocks.spawn).not.toHaveBeenCalled()
    expect(h.controller.restart).not.toHaveBeenCalled()
  })

  it('never reads or offers removal of local profile dependencies for an external runtime', async () => {
    const h = harness('external')
    mocks.pick.mockImplementationOnce(items => {
      expect(items.map((item: any) => item.action)).toEqual(['browse', 'configure', 'inventory', 'refresh'])
      return undefined
    })
    await h.manager.show()
    expect(mocks.installed).not.toHaveBeenCalled()
    expect(mocks.spawn).not.toHaveBeenCalled()
  })

  it('refuses a local install when the runtime becomes external during confirmation', async () => {
    const h = harness()
    mocks.pick.mockImplementationOnce(items => items.find((item: any) => item.action === 'install'))
    mocks.input.mockResolvedValue('@example/plugin')
    mocks.warning.mockImplementationOnce(() => { h.controller.runtimeOwnership = 'external'; return 'Install' })
    await expect(h.manager.show()).rejects.toThrow('No local profile was changed')
    expect(mocks.spawn).not.toHaveBeenCalled()
    expect(h.controller.restart).not.toHaveBeenCalled()
  })

  it('rechecks for a running task before starting the package-manager process', async () => {
    const h = harness()
    mocks.pick.mockImplementationOnce(items => items.find((item: any) => item.action === 'install'))
    mocks.input.mockResolvedValue('@example/plugin')
    mocks.warning.mockResolvedValue('Install')
    mocks.progress.mockImplementationOnce((_options, operation) => {
      h.controller.state.running = true
      return operation({}, {})
    })
    await expect(h.manager.show()).rejects.toThrow('runtime changed or a task started')
    expect(mocks.spawn).not.toHaveBeenCalled()
  })
})
