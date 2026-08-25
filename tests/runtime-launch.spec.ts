import { describe, expect, it, vi } from 'vitest'
import {
  applyRuntimeLaunchPreparation,
  type RuntimeLaunchPreparation,
} from '../src/runtime-launch.ts'

describe('managed runtime launch contributions', () => {
  it('preserves the configured arguments when no contribution is active', () => {
    const args = ['web', '--host', '127.0.0.1', '--port', '0']

    expect(applyRuntimeLaunchPreparation(args, '0.1.0-rc.8', undefined)).toEqual(args)
  })

  it('lets a contribution transform versioned arguments without mutating them', () => {
    const args = ['web', '--host', '127.0.0.1', '--port', '0', '--no-open']
    const transformArguments = vi.fn((current: readonly string[], version: string | undefined) => [
      current[0] ?? 'web',
      '--patch',
      `/tmp/debug-${version ?? 'unknown'}.yml`,
      ...current.slice(1),
    ])
    const preparation: RuntimeLaunchPreparation = { transformArguments }

    expect(applyRuntimeLaunchPreparation(args, '0.1.0-rc.8', preparation)).toEqual([
      'web',
      '--patch',
      '/tmp/debug-0.1.0-rc.8.yml',
      '--host',
      '127.0.0.1',
      '--port',
      '0',
      '--no-open',
    ])
    expect(args).toEqual(['web', '--host', '127.0.0.1', '--port', '0', '--no-open'])
    expect(transformArguments).toHaveBeenCalledWith(args, '0.1.0-rc.8')
  })
})
