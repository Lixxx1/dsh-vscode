import { describe, expect, it } from 'vitest'
import {
  agentPresetStateOf,
  lockAgentPresetState,
  selectAgentPresetState,
  unavailableAgentPresetState,
} from '../src/agent-presets.js'

const presets = [
  {
    id: 'standard',
    trust: 'system' as const,
    isDefault: true,
    name: 'Standard mode',
    description: 'Full coding agent',
  },
  {
    id: 'creator',
    trust: 'user' as const,
    isDefault: false,
    name: 'My creator',
    description: 'Local composition',
  },
  {
    id: 'broken',
    trust: 'user' as const,
    isDefault: false,
    broken: 'Composition failed to load',
  },
]

describe('Agent Preset state', () => {
  it('uses the official default for a blank session and excludes broken presets', () => {
    expect(agentPresetStateOf(presets, undefined, true)).toEqual({
      available: true,
      current: 'standard',
      locked: false,
      busy: false,
      options: [
        {
          id: 'standard',
          label: 'Standard mode',
          description: 'Full coding agent',
          trust: 'system',
          selected: true,
        },
        {
          id: 'creator',
          label: 'My creator',
          description: 'Local composition',
          trust: 'user',
          selected: false,
        },
      ],
    })
  })

  it('reflects a selected preset while the official call is in flight', () => {
    const state = agentPresetStateOf(presets, 'standard', true)
    const selected = selectAgentPresetState(state, 'creator', true)

    expect(selected.current).toBe('creator')
    expect(selected.busy).toBe(true)
    expect(selected.options.find(option => option.id === 'creator')?.selected).toBe(true)
  })

  it('locks the selector after the first turn', () => {
    const state = lockAgentPresetState(agentPresetStateOf(presets, 'creator', true))

    expect(state.locked).toBe(true)
    expect(state.current).toBe('creator')
  })

  it('stays hidden when the runtime exposes no healthy presets', () => {
    expect(agentPresetStateOf([presets[2]!], undefined, true)).toEqual(unavailableAgentPresetState())
  })
})
