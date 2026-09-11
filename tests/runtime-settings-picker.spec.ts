import { describe, expect, it, vi } from 'vitest'
import type { SettingsDescription, SettingsNamespace } from '../src/runtime-settings.js'

const mocks = vi.hoisted(() => ({ picker: undefined as any }))
vi.mock('vscode', () => ({ window: { createQuickPick: () => mocks.picker } }))
import { pickRuntimeSettingsNamespace } from '../src/runtime-settings-picker.js'

const namespace = (revision: number): SettingsNamespace => ({ ns: 'test', schema: { uid: 0, refs: { '0': { type: 'object', dict: {} } } },
  value: {}, secrets: [], applies: 'live', revision })
const description = (revision: number): SettingsDescription => ({ writable: true, hasDocument: true, namespaces: [namespace(revision)] })
function harness() {
  const changed = new Set<() => void>(), hidden = new Set<() => void>(), accepted = new Set<() => void>()
  const event = (set: Set<() => void>) => (listener: () => void) => { set.add(listener); return { dispose: () => set.delete(listener) } }
  const picker = { items: [] as any[], activeItems: [] as any[], selectedItems: [] as any[], busy: false,
    onDidHide: event(hidden), onDidAccept: event(accepted), show: vi.fn(), hide: vi.fn(), dispose: vi.fn() }
  mocks.picker = picker
  const source = { settings: vi.fn(async () => description(1)), onDidChangeRuntimeSettings: event(changed) }
  return { picker, source, changed, hide: () => hidden.forEach(f => f()), accept: () => accepted.forEach(f => f()), refresh: () => changed.forEach(f => f()) }
}

describe('runtime settings native picker', () => {
  it('refreshes an open picker after external changes and returns the latest namespace revision', async () => {
    const h = harness()
    const selected = pickRuntimeSettingsNamespace(h.source)
    await vi.waitFor(() => expect(h.picker.items).toHaveLength(1))
    h.picker.activeItems = [h.picker.items[0]]
    h.source.settings.mockResolvedValue(description(2))
    h.refresh()
    await vi.waitFor(() => expect(h.picker.items[0].namespace.revision).toBe(2))
    expect(h.picker.activeItems[0].namespace.revision).toBe(2)
    h.picker.selectedItems = [h.picker.items[0]]
    h.accept()
    expect((await selected)?.revision).toBe(2)
    expect(h.changed.size).toBe(0)
    expect(h.picker.dispose).toHaveBeenCalledTimes(1)
  })

  it('does not allow a stale selection while reloading and drops callbacks after the picker closes', async () => {
    const h = harness()
    const selected = pickRuntimeSettingsNamespace(h.source)
    await vi.waitFor(() => expect(h.picker.items).toHaveLength(1))
    h.picker.selectedItems = [h.picker.items[0]]
    const pending = Promise.withResolvers<SettingsDescription>()
    h.source.settings.mockReturnValueOnce(pending.promise)
    h.refresh(); h.accept()
    expect(h.picker.dispose).not.toHaveBeenCalled()
    h.hide()
    expect(await selected).toBeUndefined()
    pending.resolve(description(2))
    await pending.promise
    expect(h.picker.items[0].namespace.revision).toBe(1)
    expect(h.changed.size).toBe(0)
    expect(h.picker.dispose).toHaveBeenCalledTimes(1)
  })

  it('coalesces invalidations while loading and does not expose the stale response', async () => {
    const h = harness(), pending = Promise.withResolvers<SettingsDescription>()
    h.source.settings.mockReturnValueOnce(pending.promise).mockResolvedValue(description(3))
    const selected = pickRuntimeSettingsNamespace(h.source)
    h.refresh(); h.refresh()
    pending.resolve(description(1))
    await vi.waitFor(() => expect(h.picker.items[0]?.namespace.revision).toBe(3))
    expect(h.source.settings).toHaveBeenCalledTimes(2)
    h.hide()
    await selected
  })

  it('closes on a settings load failure without leaking subscriptions', async () => {
    const h = harness()
    h.source.settings.mockRejectedValue(new Error('not connected'))
    await expect(pickRuntimeSettingsNamespace(h.source)).rejects.toThrow('not connected')
    expect(h.changed.size).toBe(0)
    expect(h.picker.dispose).toHaveBeenCalledTimes(1)
  })
})
