import { normalizePluginSpec } from './plugin-profile.js'

export const COMMUNITY_REGISTRY_URL = 'https://awesome-dsh-plugin.com/plugins.json'

const RUNTIME_CATEGORIES = new Set([
  'memory',
  'tools',
  'vision',
  'skill',
  'workflow',
  'notify',
  'dev',
])

export interface CommunityRuntimePlugin {
  name: string
  owner: string
  url: string
  category: string
  categoryLabel: string
  description: string
  installSpec: string
  npm?: string
  stars?: number
}

interface CatalogOptions {
  locale?: string
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function localized(value: unknown, locale: string): string | undefined {
  const values = record(value)
  if (values === undefined) return undefined
  const language = locale.toLowerCase().startsWith('zh') ? 'zh' : 'en'
  const preferred = values[language]
  if (typeof preferred === 'string' && preferred.trim() !== '') return preferred.trim()
  const english = values.en
  return typeof english === 'string' && english.trim() !== '' ? english.trim() : undefined
}

function githubUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  try {
    const parsed = new URL(value)
    if (parsed.protocol !== 'https:' || parsed.hostname !== 'github.com') return undefined
    if (parsed.pathname.split('/').filter(Boolean).length < 2) return undefined
    return parsed.toString()
  } catch {
    return undefined
  }
}

/** Extract one argument from the registry's documented official CLI command. */
export function catalogInstallSpec(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const prefix = 'dsh plugin --profile web add '
  if (!value.startsWith(prefix)) return undefined
  let spec = value.slice(prefix.length).trim()
  if ((spec.startsWith('"') && spec.endsWith('"')) || (spec.startsWith("'") && spec.endsWith("'"))) {
    spec = spec.slice(1, -1)
  } else if (/\s/.test(spec)) {
    return undefined
  }
  try {
    return normalizePluginSpec(spec)
  } catch {
    return undefined
  }
}

/** Validate and filter the public registry to runtime capabilities usable by this sidebar. */
export function parseCommunityRuntimePlugins(
  value: unknown,
  options: CatalogOptions = {},
): CommunityRuntimePlugin[] {
  const registry = record(value)
  if (registry === undefined || !Array.isArray(registry.plugins)) {
    throw new Error('The community plugin registry returned an unsupported response.')
  }
  const locale = options.locale ?? 'en'
  const categories = record(registry.categories) ?? {}
  const plugins: CommunityRuntimePlugin[] = []

  for (const candidate of registry.plugins) {
    const entry = record(candidate)
    if (entry === undefined) continue
    const category = typeof entry.category === 'string' ? entry.category : ''
    if (!RUNTIME_CATEGORIES.has(category)) continue
    const name = typeof entry.name === 'string' ? entry.name.trim() : ''
    const owner = typeof entry.owner === 'string' ? entry.owner.trim() : ''
    const url = githubUrl(entry.url)
    const description = localized(entry.description, locale)
    const installSpec = catalogInstallSpec(entry.install)
    if (name === '' || owner === '' || url === undefined || description === undefined || installSpec === undefined) {
      continue
    }
    const categoryLabel = localized(categories[category], locale) ?? category
    const npm = typeof entry.npm === 'string' && entry.npm.trim() !== '' ? entry.npm.trim() : undefined
    const stars = typeof entry.stars === 'number' && Number.isFinite(entry.stars) && entry.stars >= 0
      ? Math.floor(entry.stars)
      : undefined
    plugins.push({
      name,
      owner,
      url,
      category,
      categoryLabel,
      description,
      installSpec,
      ...(npm === undefined ? {} : { npm }),
      ...(stars === undefined ? {} : { stars }),
    })
  }

  return plugins.sort((left, right) => {
    const categoryOrder = left.categoryLabel.localeCompare(right.categoryLabel, locale)
    if (categoryOrder !== 0) return categoryOrder
    const starOrder = (right.stars ?? -1) - (left.stars ?? -1)
    return starOrder !== 0 ? starOrder : left.name.localeCompare(right.name, locale)
  })
}
