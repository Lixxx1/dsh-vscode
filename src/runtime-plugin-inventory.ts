import { pluginEntryStatus, type InstalledPluginStatus, type PluginInventorySnapshot } from './plugin-profile.js'

export const PLUGIN_STATUS_LABELS: Record<InstalledPluginStatus, string> = {
  active: 'Active', failed: 'Failed', disabled: 'Disabled', loading: 'Loading', unloading: 'Unloading',
  configured: 'Configured · not running', conditional: 'Conditional · not evaluated', inactive: 'Not observed', unknown: 'Status unavailable',
}

export const PLUGIN_STATUS_ICONS: Record<InstalledPluginStatus, string> = {
  active: 'pass-filled', failed: 'error', disabled: 'circle-slash', loading: 'loading~spin', unloading: 'loading~spin',
  configured: 'list-tree', conditional: 'question', inactive: 'circle-outline', unknown: 'extensions',
}

export interface RuntimePluginGroup {
  label: string
  rows: Array<{ label: string; description: string; detail: string }>
}

/** Read-only Loader inventory; never turn an unmounted preset or active MCP Fiber into a connection claim. */
export function runtimePluginGroups(snapshot: PluginInventorySnapshot): RuntimePluginGroup[] {
  return [
    ...(snapshot.agentPresets ?? []).map(preset => ({
      label: `Agent preset: ${preset.name?.trim() || preset.id}${preset.isDefault ? ' (default)' : ''}`,
      rows: preset.broken !== undefined ? [{
        label: '$(error) Preset unavailable', description: preset.id,
        detail: 'This composition could not be read. Check the DSH runtime logs.',
      }] : preset.rows.map(row => ({
        label: `$(${PLUGIN_STATUS_ICONS[pluginEntryStatus(row, true)]}) ${row.moduleName}`,
        description: PLUGIN_STATUS_LABELS[pluginEntryStatus(row, true)],
        detail: `Preset: ${preset.id} · ${preset.trust} · Entry: ${row.entryId ?? '(no id)'}`,
      })),
    })),
    { label: 'Global runtime', rows: snapshot.entries.map(row => ({
      label: `$(${PLUGIN_STATUS_ICONS[pluginEntryStatus(row, false)]}) ${row.moduleName}`,
      description: PLUGIN_STATUS_LABELS[pluginEntryStatus(row, false)], detail: `Global · Entry: ${row.entryId}`,
    })) },
  ]
}
