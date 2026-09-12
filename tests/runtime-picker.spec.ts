import { beforeEach, describe, expect, it, vi } from 'vitest'

const ui = vi.hoisted(() => ({ input: vi.fn(), confirm: vi.fn(), debugging: false }))
vi.mock('vscode', () => ({
  Uri: { file: (fsPath: string) => ({ fsPath }) },
  workspace: { getConfiguration: () => ({ get: () => ui.debugging }) },
  window: { showInputBox: ui.input, showWarningMessage: ui.confirm },
}))
import { pickExistingRuntime, pickManagedRuntime } from '../src/runtime-picker.js'

const url = 'http://127.0.0.1:43127/?token=private-token'
function host(ownership: 'managed' | 'external' | undefined = undefined) {
  return { cwd: '/workspace', runtimeOwnership: ownership, assertCanSelectRuntime: vi.fn(), selectRuntime: vi.fn(async () => {}) }
}
beforeEach(() => { ui.input.mockReset(); ui.confirm.mockReset(); ui.debugging = false })

describe('native runtime picker', () => {
  it('keeps the URL in a password box and only passes a validated target to the host', async () => {
    const h = host(); ui.input.mockResolvedValue(url)
    await pickExistingRuntime(h)
    const options = ui.input.mock.calls[0]![0]
    expect(options).toMatchObject({ password: true, ignoreFocusOut: true })
    expect(options.validateInput(url)).toBeUndefined()
    expect(options.validateInput('http://remote/?token=private-token')).not.toContain('private-token')
    expect(h.selectRuntime).toHaveBeenCalledWith({ kind: 'external', launchUrl: new URL(url) })
    expect(ui.confirm).not.toHaveBeenCalled()
  })

  it('leaves the connection untouched when input is cancelled', async () => {
    const h = host('managed'); ui.input.mockResolvedValue(undefined)
    await pickExistingRuntime(h)
    expect(h.selectRuntime).not.toHaveBeenCalled()
    expect(ui.confirm).not.toHaveBeenCalled()
  })

  it('requires confirmation before stopping a managed process and its jobs', async () => {
    const h = host('managed'); ui.input.mockResolvedValue(url)
    await pickExistingRuntime(h)
    expect(ui.confirm).toHaveBeenCalledWith(expect.stringContaining('background jobs'), { modal: true }, 'Switch Runtime')
    expect(h.selectRuntime).not.toHaveBeenCalled()
    ui.confirm.mockResolvedValue('Switch Runtime')
    await pickExistingRuntime(h)
    expect(h.selectRuntime).toHaveBeenCalledTimes(1)
  })

  it('never forwards a malformed URL even if the native validator is bypassed', async () => {
    const h = host(); ui.input.mockResolvedValue('private-token')
    await expect(pickExistingRuntime(h)).rejects.toThrow('Paste the full launch URL')
    expect(h.selectRuntime).not.toHaveBeenCalled()
  })

  it('rejects external runtimes with autonomous debugging enabled', async () => {
    const h = host(); ui.debugging = true
    await expect(pickExistingRuntime(h)).rejects.toThrow('managed runtime')
    expect(ui.input).not.toHaveBeenCalled()
    expect(h.selectRuntime).not.toHaveBeenCalled()
  })

  it('rechecks debugging settings after the input and confirmation dialogs', async () => {
    const h = host('managed'); ui.input.mockResolvedValue(url)
    ui.confirm.mockImplementation(async () => { ui.debugging = true; return 'Switch Runtime' })
    await expect(pickExistingRuntime(h)).rejects.toThrow('managed runtime')
    expect(h.selectRuntime).not.toHaveBeenCalled()
  })

  it('rechecks running tasks after input before offering to stop a runtime', async () => {
    const h = host('managed')
    ui.input.mockImplementation(async () => { h.assertCanSelectRuntime.mockImplementation(() => { throw new Error('task running') }); return url })
    await expect(pickExistingRuntime(h)).rejects.toThrow('task running')
    expect(ui.confirm).not.toHaveBeenCalled()
    expect(h.selectRuntime).not.toHaveBeenCalled()
  })

  it('provides an explicit managed target without requiring a launch URL', async () => {
    const h = host('external')
    await pickManagedRuntime(h)
    expect(h.selectRuntime).toHaveBeenCalledWith({ kind: 'managed' })
    expect(ui.input).not.toHaveBeenCalled()
    expect(ui.confirm).not.toHaveBeenCalled()
  })
})
