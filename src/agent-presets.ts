import type { AgentPresetDescriptor } from './dsh-client.js'

export interface AgentPresetOption {
  id: string
  label: string
  description?: string
  trust: 'system' | 'user'
  selected: boolean
}

export interface AgentPresetState {
  available: boolean
  current: string
  locked: boolean
  busy: boolean
  options: AgentPresetOption[]
}

export function unavailableAgentPresetState(): AgentPresetState {
  return { available: false, current: '', locked: true, busy: false, options: [] }
}

export function agentPresetStateOf(
  presets: readonly AgentPresetDescriptor[],
  current: string | undefined,
  blank: boolean,
  busy = false,
): AgentPresetState {
  const healthy = presets.filter(preset => preset.broken === undefined)
  if (healthy.length === 0) return unavailableAgentPresetState()
  const fallback = healthy.find(preset => preset.isDefault)?.id ?? healthy[0]?.id ?? ''
  const selected = healthy.some(preset => preset.id === current) ? current ?? fallback : fallback
  return {
    available: true,
    current: selected,
    locked: !blank,
    busy,
    options: healthy.map(preset => ({
      id: preset.id,
      label: preset.name?.trim() || preset.id,
      ...(preset.description === undefined ? {} : { description: preset.description }),
      trust: preset.trust,
      selected: preset.id === selected,
    })),
  }
}

export function selectAgentPresetState(state: AgentPresetState, id: string, busy = state.busy): AgentPresetState {
  if (!state.options.some(option => option.id === id)) return state
  return {
    ...state,
    current: id,
    busy,
    options: state.options.map(option => ({ ...option, selected: option.id === id })),
  }
}

export function lockAgentPresetState(state: AgentPresetState): AgentPresetState {
  return state.available && !state.locked ? { ...state, locked: true, busy: false } : state
}
