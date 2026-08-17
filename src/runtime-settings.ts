export interface SettingsSchemaNode {
  type?: string
  meta?: {
    description?: string
    min?: number
    max?: number
    step?: number
    role?: string
    [key: string]: unknown
  }
  dict?: Record<string, number>
  list?: number[]
  value?: unknown
}

export interface SettingsSchema {
  uid: number
  refs: Record<string, SettingsSchemaNode>
}

export interface SettingsSecret {
  path: string[]
  set: boolean
}

export interface SettingsNamespace {
  ns: string
  schema: SettingsSchema
  value: unknown
  base?: unknown
  user?: unknown
  applies: 'live' | 'restart'
  secrets: SettingsSecret[]
  revision: number
}

export interface SettingsDescription {
  writable: boolean
  hasDocument: boolean
  namespaces: SettingsNamespace[]
}

export type SettingsMutation =
  | { op: 'set'; path: string[]; value: unknown }
  | { op: 'unset'; path: string[] }

export interface RuntimeSettingField {
  path: string[]
  node: SettingsSchemaNode
  value: unknown
  inherited: unknown
  overridden: boolean
  secretSet?: boolean
}

function nodeOf(schema: SettingsSchema, uid: number): SettingsSchemaNode | undefined {
  return schema.refs[String(uid)]
}

function valueAt(value: unknown, path: readonly string[]): unknown {
  let current = value
  for (const segment of path) {
    if (current === null || typeof current !== 'object' || Array.isArray(current)) return undefined
    current = (current as Record<string, unknown>)[segment]
  }
  return current
}

function ownsPath(value: unknown, path: readonly string[]): boolean {
  let current = value
  for (const segment of path) {
    if (current === null || typeof current !== 'object' || Array.isArray(current)
      || !Object.prototype.hasOwnProperty.call(current, segment)) return false
    current = (current as Record<string, unknown>)[segment]
  }
  return true
}

function samePath(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((part, index) => part === right[index])
}

export function runtimeSettingFields(namespace: SettingsNamespace): RuntimeSettingField[] {
  const fields: RuntimeSettingField[] = []
  const visit = (uid: number, path: string[]): void => {
    const node = nodeOf(namespace.schema, uid)
    if (node === undefined) return
    if (node.type === 'object' && node.dict !== undefined) {
      for (const [key, childUid] of Object.entries(node.dict)) visit(childUid, [...path, key])
      return
    }
    const secret = namespace.secrets.find(candidate => samePath(candidate.path, path))
    fields.push({
      path,
      node,
      value: valueAt(namespace.value, path),
      inherited: valueAt(namespace.base, path),
      overridden: ownsPath(namespace.user, path),
      ...(secret === undefined ? {} : { secretSet: secret.set }),
    })
  }
  visit(namespace.schema.uid, [])
  return fields
}

export function settingConstantOptions(field: RuntimeSettingField, schema: SettingsSchema): unknown[] | undefined {
  if (field.node.type === 'boolean') return [true, false]
  if (field.node.type !== 'union' || field.node.list === undefined) return undefined
  const options: unknown[] = []
  for (const uid of field.node.list) {
    const node = nodeOf(schema, uid)
    if (node?.type !== 'const') return undefined
    options.push(node.value)
  }
  return options
}

export function parseRuntimeSetting(field: RuntimeSettingField, source: string): unknown {
  if (field.node.type === 'string') return source
  if (field.node.type === 'number') {
    const value = Number(source)
    if (!Number.isFinite(value)) throw new Error('Enter a valid number.')
    const min = field.node.meta?.min
    const max = field.node.meta?.max
    if (min !== undefined && value < min) throw new Error(`Value must be at least ${String(min)}.`)
    if (max !== undefined && value > max) throw new Error(`Value must be at most ${String(max)}.`)
    return value
  }
  try {
    return JSON.parse(source) as unknown
  } catch {
    throw new Error('Enter a valid JSON value.')
  }
}

export function hasSettingsOverrides(namespace: SettingsNamespace): boolean {
  return namespace.user !== null && typeof namespace.user === 'object'
    && !Array.isArray(namespace.user) && Object.keys(namespace.user).length > 0
}

