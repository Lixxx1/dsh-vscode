import { describe, expect, it } from 'vitest'
import { runtimePluginGroups } from '../src/runtime-plugin-inventory.js'
import { installedPluginStatus, pluginEntryStatus, type AgentPresetPluginGroup, type AgentPresetPluginRow } from '../src/plugin-profile.js'

const row = (overrides: Partial<AgentPresetPluginRow> = {}): AgentPresetPluginRow => ({
  entryId: 'tool', moduleName: '@example/plugin/tool', enabled: true, fiberPhase: null, ...overrides,
})
const preset = (rows: AgentPresetPluginRow[], overrides: Partial<AgentPresetPluginGroup> = {}): AgentPresetPluginGroup => ({
  id: 'coding', name: 'Coding', trust: 'system', isDefault: true, rows, ...overrides,
})

describe('rc.1 runtime inventory', () => {
  it('does not report an unmounted or conditional preset plugin as active', () => {
    expect(pluginEntryStatus(row(), true)).toBe('configured')
    expect(pluginEntryStatus(row(), false)).toBe('inactive')
    expect(pluginEntryStatus(row({ enabled: 'conditional' }), true)).toBe('conditional')
    expect(pluginEntryStatus(row({ enabled: false, fiberPhase: 'failed' }), true)).toBe('disabled')
    expect(pluginEntryStatus(row({ fiberPhase: 'unloading' }), true)).toBe('unloading')
    expect(pluginEntryStatus(row({ fiberPhase: 'pending' }), true)).toBe('loading')
  })

  it('includes preset-only modules in bundle status, prioritizing incomplete or failed loads', () => {
    const inventory = { entries: [], agentPresets: [preset([row()])] }
    expect(installedPluginStatus('@example/plugin', inventory)).toBe('configured')
    inventory.agentPresets[0]!.rows = [row({ fiberPhase: 'active' }), row({ fiberPhase: 'failed' })]
    expect(installedPluginStatus('@example/plugin', inventory)).toBe('failed')
    inventory.agentPresets[0]!.rows = [row({ fiberPhase: 'active' }), row({ fiberPhase: 'loading' })]
    expect(installedPluginStatus('@example/plugin', inventory)).toBe('loading')
    expect(installedPluginStatus('@example/plug', inventory)).toBe('unknown')
  })

  it('keeps global and per-preset status separate, including broken and empty presets', () => {
    const groups = runtimePluginGroups({
      entries: [{ entryId: 'mcp', moduleName: '@deepseek-ai/dsh-mcp-client', enabled: true, fiberPhase: 'active' }],
      agentPresets: [preset([row()]), preset([], { id: 'empty', name: '', isDefault: false }),
        preset([], { id: 'broken', broken: 'private loader diagnostics', isDefault: false })],
    })
    expect(groups.map(group => group.label)).toEqual(['Agent preset: Coding (default)', 'Agent preset: empty', 'Agent preset: Coding', 'Global runtime'])
    expect(groups[0]?.rows[0]).toMatchObject({ description: 'Configured · not running', detail: 'Preset: coding · system · Entry: tool' })
    expect(groups[1]?.rows).toEqual([])
    expect(groups[2]?.rows[0]?.label).toContain('Preset unavailable')
    expect(groups[3]?.rows[0]?.description).toBe('Active')
    expect(JSON.stringify(groups)).not.toMatch(/connected|private loader diagnostics/)
  })

  it('does not assume preset support or infer bundle provenance from unrelated modules', () => {
    expect(runtimePluginGroups({ entries: [] })).toEqual([{ label: 'Global runtime', rows: [] }])
    expect(installedPluginStatus('bundle-wrapper', { entries: [], agentPresets: [preset([row()])] })).toBe('unknown')
    expect(installedPluginStatus('@example/plugin', { entries: [], agentPresets: [preset([row()], { broken: 'error' })] })).toBe('unknown')
  })
})
