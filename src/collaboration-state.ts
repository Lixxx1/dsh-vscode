export interface PermissionPresetItem {
  value: string
  label: string
  description?: string
  selected: boolean
}

export interface PlanModeState {
  available: boolean
  active: boolean
  pending: boolean
}

const PERMISSION_LABELS: Readonly<Record<string, string>> = {
  'read-only': 'Read Only',
  'workspace-write': 'Workspace',
  'danger-full-access': 'Full Access',
}

export function permissionPresetsOf(value: unknown): PermissionPresetItem[] {
  if (typeof value !== 'object' || value === null) return []
  const select = value as Record<string, unknown>
  const current = typeof select.currentValue === 'string' ? select.currentValue : ''
  if (!Array.isArray(select.options)) return []
  return select.options.flatMap((value): PermissionPresetItem[] => {
    if (typeof value !== 'object' || value === null) return []
    const option = value as Record<string, unknown>
    if (typeof option.value !== 'string' || option.value === 'custom') return []
    return [{
      value: option.value,
      label: PERMISSION_LABELS[option.value]
        ?? (typeof option.name === 'string' ? option.name : option.value),
      ...(typeof option.description === 'string' ? { description: option.description } : {}),
      selected: option.value === current,
    }]
  })
}

export function planModeStateOf(value: unknown): PlanModeState {
  if (typeof value !== 'object' || value === null) {
    return { available: false, active: false, pending: false }
  }
  const plan = value as Record<string, unknown>
  if (typeof plan.active !== 'boolean' || typeof plan.pending !== 'boolean') {
    return { available: false, active: false, pending: false }
  }
  return { available: true, active: plan.active, pending: plan.pending }
}

export function effectivePlanMode(plan: PlanModeState): boolean {
  return plan.pending ? !plan.active : plan.active
}

export function planModeWithCommandAvailability(plan: PlanModeState, available: boolean): PlanModeState {
  return available && !plan.available ? { ...plan, available: true } : plan
}

export function planModeCommand(mode: 'normal' | 'plan'): '/plan' | '/plan off' {
  return mode === 'plan' ? '/plan' : '/plan off'
}

export function requiresFullAccessConfirmation(value: string): boolean {
  return value === 'danger-full-access'
}
