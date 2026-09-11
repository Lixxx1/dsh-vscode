import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  pick: vi.fn(), warning: vi.fn(), input: vi.fn(), progress: vi.fn(), installed: vi.fn(), spawn: vi.fn(),
}))
vi.mock('vscode', () => ({
  QuickPickItemKind: { Separator: -1 }, ProgressLocation: { Notification: 15 },
  window: { showQuickPick: mocks.pick, showWarningMessage: mocks.warning, showInputBox: mocks.input, withProgress: mocks.progress },
  workspace: { getWorkspaceFolder: () => undefined, getConfiguration: () => ({ get: () => '' }) },
  Uri: { file: (fsPath: string) => ({ fsPath }) },
}))
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }))
vi.mock('../src/launch.js', () => ({ resolveLaunch: () => ({ command: 'dsh', args: [], sourceCheckout: false }) }))
vi.mock('../src/plugin-profile.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/plugin-profile.js')>(), readInstalledPlugins: mocks.installed,
}))
import { DshPluginManager } from '../src/plugin-manager.js'

function harness(ownership: 'external' | 'managed' = 'managed') {
  const controller = {
    runtimeOwnership: ownership, cwd: '/workspace', state: { phase: 'ready', statusText: '', running: false },
    pluginInventory: vi.fn(async () => ({ entries: [], agentPresets: [{ id: 'coding', trust: 'system', isDefault: true,
      rows: [{ entryId: 'mcp', moduleName: '@deepseek-ai/dsh-mcp-client', enabled: true, fiberPhase: null }] }] })),
    restart: vi.fn(),
  }
  const manager = new DshPluginManager({ extensionUri: { fsPath: '/extension' } } as any, controller as any,
    { appendLine: vi.fn() } as any)
  return { controller, manager }
}
beforeEach(() => { vi.clearAllMocks(); mocks.installed.mockReturnValue([]) })

describe('runtime plugin management', () => {
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
