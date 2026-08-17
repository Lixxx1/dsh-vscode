import { describe, expect, it } from 'vitest'
import {
  effectivePlanMode,
  permissionPresetsOf,
  planModeStateOf,
  requiresFullAccessConfirmation,
} from '../src/collaboration-state.js'

describe('collaboration state projections', () => {
  it('uses the official permission projection as the selector source', () => {
    expect(permissionPresetsOf({
      currentValue: 'workspace-write',
      options: [
        { value: 'read-only', name: 'read-only', description: 'Read without modifying files.' },
        { value: 'workspace-write', name: 'workspace-write', description: 'Write in this workspace.' },
        { value: 'danger-full-access', name: 'danger-full-access', description: 'No sandbox.' },
        { value: 'custom', name: 'custom' },
      ],
    })).toEqual([
      { value: 'read-only', label: 'Read Only', description: 'Read without modifying files.', selected: false },
      { value: 'workspace-write', label: 'Workspace', description: 'Write in this workspace.', selected: true },
      { value: 'danger-full-access', label: 'Full Access', description: 'No sandbox.', selected: false },
    ])
  })

  it('distinguishes an unavailable plan capability from normal mode', () => {
    expect(planModeStateOf(undefined)).toEqual({ available: false, active: false, pending: false })
    expect(planModeStateOf({ active: false, pending: false })).toEqual({ available: true, active: false, pending: false })
    expect(planModeStateOf({ active: true, pending: false })).toEqual({ available: true, active: true, pending: false })
  })

  it('shows the target mode while an official plan transition is pending', () => {
    expect(effectivePlanMode({ available: true, active: false, pending: true })).toBe(true)
    expect(effectivePlanMode({ available: true, active: true, pending: true })).toBe(false)
  })

  it('requires confirmation only for the official full-access preset', () => {
    expect(requiresFullAccessConfirmation('danger-full-access')).toBe(true)
    expect(requiresFullAccessConfirmation('workspace-write')).toBe(false)
  })
})
