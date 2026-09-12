import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeChangeController } from '../src/runtime-change.js'

const mocks = vi.hoisted(() => ({
  input: vi.fn(), warning: vi.fn(), info: vi.fn(), error: vi.fn(), config: vi.fn(), listen: vi.fn(),
}))
vi.mock('vscode', () => ({
  window: { showInputBox: mocks.input, showWarningMessage: mocks.warning, showInformationMessage: mocks.info, showErrorMessage: mocks.error },
  workspace: { getConfiguration: () => ({ get: mocks.config }), onDidChangeConfiguration: mocks.listen },
  Uri: { file: (fsPath: string) => ({ fsPath }) },
}))
import { configureApiKey, clearApiKey, watchDebugConfiguration } from '../src/runtime-configuration.js'
import { restartAfterRuntimeChange, runtimeChangeTarget } from '../src/runtime-change.js'
import { DEEPSEEK_API_KEY_SECRET } from '../src/credentials.js'

function harness() {
  const controller = {
    isDisposed: false, cwd: '/workspace', runtimeIdentity: {} as object | undefined,
    runtimeOwnership: 'managed' as RuntimeChangeController['runtimeOwnership'],
    hasRunningTasks: false, state: { phase: 'ready' as 'ready' | 'loading' | 'error', statusText: '' },
    restart: vi.fn(async () => true), start: vi.fn(async () => {}),
  }
  const secrets = { store: vi.fn(async () => {}), delete: vi.fn(async () => {}) }
  const output = { appendLine: vi.fn() }
  return { controller, secrets, output,
    configure: () => configureApiKey(controller, secrets as any, output as any),
    clear: () => clearApiKey(controller, secrets as any, output as any),
    watch: () => {
      const dispose = vi.fn(); mocks.listen.mockReturnValueOnce({ dispose })
      const subscription = watchDebugConfiguration(controller, { fsPath: '/workspace' } as any, output as any)
      return { subscription, dispose, change: (enabled = true, affects = true) => {
        mocks.config.mockReturnValue(enabled)
        mocks.listen.mock.calls.at(-1)![0]({ affectsConfiguration: () => affects })
      } }
    },
  }
}
beforeEach(() => { vi.resetAllMocks(); mocks.input.mockResolvedValue('sk-test'); mocks.warning.mockResolvedValue('Remove') })
afterEach(() => vi.useRealTimers())

describe('safe automatic runtime restarts', () => {
  it.each(['identity', 'cwd', 'loading', 'disconnected', 'busy', 'external', 'disposed'])(
    'does not restart a %s target', async reason => {
      const h = harness(), target = runtimeChangeTarget(h.controller)
      if (reason === 'identity') h.controller.runtimeIdentity = {}
      if (reason === 'cwd') h.controller.cwd = '/another'
      if (reason === 'loading') h.controller.state.phase = 'loading'
      if (reason === 'disconnected') h.controller.state.phase = 'error'
      if (reason === 'busy') h.controller.hasRunningTasks = true
      if (reason === 'external') h.controller.runtimeOwnership = 'external'
      if (reason === 'disposed') h.controller.isDisposed = true
      await restartAfterRuntimeChange(h.controller, target, 'Settings saved')
      expect(h.controller.restart).not.toHaveBeenCalled()
      expect(mocks.info).not.toHaveBeenCalled()
    },
  )

  it('does not report success for a superseded restart', async () => {
    const h = harness(); h.controller.restart.mockResolvedValue(false)
    await restartAfterRuntimeChange(h.controller, runtimeChangeTarget(h.controller), 'Settings saved')
    expect(mocks.info).not.toHaveBeenCalled()
  })

  it('surfaces a failed restart without a success notice', async () => {
    const h = harness()
    h.controller.restart.mockImplementation(async () => { h.controller.state = { phase: 'error', statusText: 'Offline' }; return true })
    await expect(restartAfterRuntimeChange(h.controller, runtimeChangeTarget(h.controller), 'Settings saved')).rejects.toThrow('Offline')
    expect(mocks.info).not.toHaveBeenCalled()
  })
})

describe('credential configuration', () => {
  it('stores a normalized key and restarts an idle runtime without logging the key', async () => {
    const h = harness(); mocks.input.mockResolvedValue(' sk-test ')
    await h.configure()
    expect(h.secrets.store).toHaveBeenCalledWith(DEEPSEEK_API_KEY_SECRET, 'sk-test')
    expect(h.controller.restart).toHaveBeenCalledTimes(1)
    expect(mocks.info).toHaveBeenCalledWith('DeepSeek API key configured. DeepSeek Harness restarted.')
    expect(JSON.stringify(h.output.appendLine.mock.calls)).not.toContain('sk-test')
  })

  it('does not save or restart after the password dialog is cancelled', async () => {
    const h = harness(); mocks.input.mockResolvedValue(undefined)
    await h.configure()
    expect(h.secrets.store).not.toHaveBeenCalled(); expect(h.controller.restart).not.toHaveBeenCalled()
  })

  it('does not save credentials to a different runtime selected during the dialog', async () => {
    const h = harness(); mocks.input.mockImplementation(async () => { h.controller.runtimeIdentity = {}; return 'sk-test' })
    await h.configure()
    expect(h.secrets.store).not.toHaveBeenCalled(); expect(h.controller.restart).not.toHaveBeenCalled()
  })

  it.each(['configure', 'clear'] as const)('defers %s restart if a job starts during SecretStorage completion', async action => {
    const h = harness()
    h.secrets[action === 'configure' ? 'store' : 'delete'].mockImplementation(async () => { h.controller.hasRunningTasks = true })
    await h[action]()
    expect(h.controller.restart).not.toHaveBeenCalled()
    expect(mocks.warning).toHaveBeenCalledWith(expect.stringContaining('Background Jobs'))
    expect(mocks.info).not.toHaveBeenCalled()
  })

  it.each(['configure', 'clear'] as const)('does not restart a replacement runtime after %s storage completes', async action => {
    const h = harness()
    h.secrets[action === 'configure' ? 'store' : 'delete'].mockImplementation(async () => { h.controller.runtimeIdentity = {} })
    await h[action]()
    expect(h.controller.restart).not.toHaveBeenCalled()
    expect(mocks.warning).toHaveBeenCalledWith(expect.stringContaining('no runtime was restarted'))
  })

  it('does not restart a new runtime selected during the removal confirmation', async () => {
    const h = harness(); mocks.warning.mockImplementationOnce(async () => { h.controller.runtimeIdentity = {}; return 'Remove' })
    await h.clear()
    expect(h.secrets.delete).toHaveBeenCalledTimes(1); expect(h.controller.restart).not.toHaveBeenCalled()
  })

  it('keeps the external runtime credentials and process untouched', async () => {
    const h = harness(); h.controller.runtimeOwnership = 'external'
    await h.configure(); await h.clear()
    expect(mocks.input).not.toHaveBeenCalled(); expect(h.secrets.store).not.toHaveBeenCalled()
    expect(h.secrets.delete).toHaveBeenCalledWith(DEEPSEEK_API_KEY_SECRET)
    expect(h.controller.restart).not.toHaveBeenCalled()
    expect(mocks.info).toHaveBeenCalledWith(expect.stringContaining('external DSH keeps its own credentials'))
  })

  it('can repair a managed startup failure by storing the key then restarting', async () => {
    const h = harness(); h.controller.runtimeOwnership = undefined; h.controller.runtimeIdentity = undefined; h.controller.state.phase = 'error'
    h.controller.restart.mockImplementation(async () => { h.controller.state.phase = 'ready'; return true })
    await h.configure()
    expect(h.controller.start).toHaveBeenCalledTimes(1); expect(h.controller.restart).toHaveBeenCalledTimes(1)
  })
})

describe('debug configuration watcher', () => {
  it('debounces changes and restarts only for the latest setting', async () => {
    vi.useFakeTimers(); const h = harness(), w = h.watch()
    w.change(true); w.change(false)
    await vi.advanceTimersByTimeAsync(200)
    expect(h.controller.restart).toHaveBeenCalledTimes(1)
    expect(mocks.info).toHaveBeenCalledWith('VS Code debugging disabled. DeepSeek Harness restarted.')
    w.subscription.dispose()
  })

  it.each(['busy', 'changed', 'disposed', 'external', 'stopped', 'unrelated'])(
    'does not restart for a %s debug setting change', async reason => {
      vi.useFakeTimers(); const h = harness(), w = h.watch()
      if (reason === 'stopped') { h.controller.runtimeIdentity = undefined; h.controller.runtimeOwnership = undefined }
      if (reason === 'external') h.controller.runtimeOwnership = 'external'
      w.change(true, reason !== 'unrelated')
      if (reason === 'busy') h.controller.hasRunningTasks = true
      if (reason === 'changed') h.controller.runtimeIdentity = {}
      if (reason === 'disposed') w.subscription.dispose()
      await vi.advanceTimersByTimeAsync(200)
      expect(h.controller.restart).not.toHaveBeenCalled()
      w.subscription.dispose()
    },
  )

  it('suppresses stale success notifications when a later setting arrives during restart', async () => {
    vi.useFakeTimers(); const h = harness(), w = h.watch(), restart = Promise.withResolvers<boolean>()
    h.controller.restart.mockImplementationOnce(() => { h.controller.state.phase = 'loading'; return restart.promise })
    w.change(true); await vi.advanceTimersByTimeAsync(200)
    w.change(false); await vi.advanceTimersByTimeAsync(200)
    restart.resolve(true); await vi.advanceTimersByTimeAsync(0)
    expect(h.controller.restart).toHaveBeenCalledTimes(1)
    expect(mocks.info).not.toHaveBeenCalled()
    w.subscription.dispose()
  })
})
