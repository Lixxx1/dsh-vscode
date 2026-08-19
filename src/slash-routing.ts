export interface NamedSlashSource {
  name: string
}

export type SlashRoute =
  | { kind: 'command'; name: string; token: string }
  | { kind: 'skill'; name: string; token: string }
  | { kind: 'unknown'; token: string }
  | { kind: 'prompt' }

/** Resolves a slash-prefixed composer value using the same command-before-skill precedence as DSH. */
export function routeSlashInput(
  text: string,
  commands: readonly NamedSlashSource[],
  skills: readonly NamedSlashSource[],
): SlashRoute {
  const normalized = text.trim()
  if (!normalized.startsWith('/')) return { kind: 'prompt' }
  const token = normalized.split(/\s/, 1)[0] ?? normalized
  const name = /^\/([a-z0-9-]+)$/.exec(token)?.[1]
  if (name === undefined) return { kind: 'unknown', token }
  if (commands.some(command => command.name === name)) return { kind: 'command', name, token }
  if (skills.some(skill => skill.name === name)) return { kind: 'skill', name, token }
  return { kind: 'unknown', token }
}
