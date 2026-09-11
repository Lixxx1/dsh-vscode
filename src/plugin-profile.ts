import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

export type PluginFiberPhase = 'pending' | 'loading' | 'active' | 'failed' | 'unloading' | null

export interface PluginInventoryEntry {
  entryId: string
  moduleName: string
  enabled: boolean
  fiberPhase: PluginFiberPhase
}

export interface PluginInventorySnapshot {
  entries: readonly PluginInventoryEntry[]
  agentPresets?: readonly AgentPresetPluginGroup[]
}

export interface AgentPresetPluginRow {
  entryId: string | null
  moduleName: string
  enabled: boolean | 'conditional'
  condition?: string
  fiberPhase: PluginFiberPhase
}

export interface AgentPresetPluginGroup {
  id: string
  trust: 'system' | 'user'
  name?: string
  isDefault: boolean
  broken?: string
  rows: readonly AgentPresetPluginRow[]
}

export interface InstalledPlugin {
  name: string
  spec: string
  bundle: boolean
}

export type InstalledPluginStatus = 'active' | 'failed' | 'disabled' | 'loading' | 'unloading' | 'configured' | 'conditional' | 'inactive' | 'unknown'

interface ProfileManifest {
  dependencies?: Record<string, unknown>
  dsh?: { profile?: { bundles?: unknown[] } }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/** Resolve the same user-data root used by DSH: DSH_HOME, then ~/.dsh. */
export function resolveDshHome(
  env: NodeJS.ProcessEnv = process.env,
  userHome: string = homedir(),
): string {
  const configured = env.DSH_HOME?.trim()
  if (configured === undefined || configured === '') return join(userHome, '.dsh')
  if (configured === '~') return userHome
  if (configured.startsWith('~/') || configured.startsWith('~\\')) {
    return resolve(userHome, configured.slice(2))
  }
  return resolve(configured)
}

/** Read the official web profile without mutating DSH-owned state. */
export function readInstalledPlugins(dshHome: string): InstalledPlugin[] {
  const manifestPath = join(dshHome, 'profiles', 'web', 'package.json')
  let source: string
  try {
    source = readFileSync(manifestPath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }

  let manifest: ProfileManifest
  try {
    manifest = JSON.parse(source) as ProfileManifest
  } catch {
    throw new Error(`The DSH web profile manifest is not valid JSON: ${manifestPath}`)
  }

  const dependencies = record(manifest.dependencies) ?? {}
  const bundleValues = manifest.dsh?.profile?.bundles ?? []
  const bundles = new Set(bundleValues.filter((value): value is string => typeof value === 'string'))
  return Object.entries(dependencies)
    .flatMap(([name, spec]): InstalledPlugin[] => typeof spec === 'string'
      ? [{ name, spec, bundle: bundles.has(name) }]
      : [])
    .sort((left, right) => left.name.localeCompare(right.name))
}

/** A configured preset row without a live Fiber is not an active plugin. */
export function pluginEntryStatus(entry: AgentPresetPluginRow, preset: boolean): InstalledPluginStatus {
  if (entry.enabled === false) return 'disabled'
  if (entry.enabled === 'conditional') return 'conditional'
  if (entry.fiberPhase === 'pending' || entry.fiberPhase === 'loading') return 'loading'
  if (entry.fiberPhase !== null) return entry.fiberPhase
  return preset ? 'configured' : 'inactive'
}

/** Match a bundle to observed entries and preset declarations, without inferring MCP connectivity. */
export function installedPluginStatus(
  pluginName: string,
  inventory: PluginInventorySnapshot | undefined,
): InstalledPluginStatus {
  if (inventory === undefined) return 'unknown'
  const matches = (entry: AgentPresetPluginRow): boolean => entry.moduleName === pluginName || entry.moduleName.startsWith(`${pluginName}/`)
  const states = [
    ...inventory.entries.filter(matches).map(entry => pluginEntryStatus(entry, false)),
    ...(inventory.agentPresets ?? []).filter(preset => preset.broken === undefined)
      .flatMap(preset => preset.rows.filter(matches).map(entry => pluginEntryStatus(entry, true))),
  ]
  for (const status of ['failed', 'loading', 'unloading', 'active', 'configured', 'conditional', 'inactive', 'disabled'] as const) {
    if (states.includes(status)) return status
  }
  return 'unknown'
}

/** Accept one pnpm package spec while preventing option injection into the official CLI forwarder. */
export function normalizePluginSpec(value: string): string {
  const spec = value.trim()
  if (spec === '') throw new Error('Enter an npm package, GitHub source, tarball, or local plugin path.')
  if (spec.startsWith('-')) throw new Error('Plugin sources cannot start with a command-line option.')
  if (/[\0\r\n]/.test(spec)) throw new Error('Plugin sources must fit on one line.')
  return spec
}

/** Identify the dependency introduced by a successful official add command. */
export function findAddedPlugin(
  before: readonly InstalledPlugin[],
  after: readonly InstalledPlugin[],
): InstalledPlugin | undefined {
  const previousNames = new Set(before.map(plugin => plugin.name))
  return after.find(plugin => !previousNames.has(plugin.name))
}
