const SENSITIVE_NAME = /(?:api[_-]?key|access[_-]?token|authorization|auth[_-]?token|cookie|credential|password|passwd|secret|session[_-]?token)/i

export interface DebugVariableValue {
  readonly name: string
  readonly value: string
  readonly type?: string
  readonly expandable: boolean
}

export function compactDebugText(value: string, maxChars = 240): string {
  const normalized = value.replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim()
  return normalized.length <= maxChars ? normalized : `${normalized.slice(0, Math.max(0, maxChars - 1))}…`
}

export function isRuntimeInternalSource(value: string | undefined): boolean {
  if (value === undefined) return false
  const normalized = value.replace(/\\/g, '/').toLowerCase()
  return normalized.startsWith('<node_internals>/')
    || normalized.startsWith('node:internal/')
    || normalized.includes('/node:internal/')
}

export function debugVariableValue(
  name: string,
  value: string,
  type: string | undefined,
  variablesReference: number,
): DebugVariableValue {
  return {
    name: compactDebugText(name, 120),
    value: SENSITIVE_NAME.test(name) ? '<redacted>' : compactDebugText(value),
    ...(type === undefined || type.trim() === '' ? {} : { type: compactDebugText(type, 120) }),
    expandable: variablesReference > 0,
  }
}

export function launchConfigurationNames(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const names = new Set<string>()
  for (const item of value) {
    if (typeof item !== 'object' || item === null) continue
    const name = (item as Record<string, unknown>).name
    const type = (item as Record<string, unknown>).type
    const request = (item as Record<string, unknown>).request
    if (typeof name !== 'string' || name.trim() === '') continue
    if (typeof type !== 'string' || type.trim() === '') continue
    if (request !== 'launch' && request !== 'attach') continue
    names.add(name.trim())
  }
  return [...names]
}
