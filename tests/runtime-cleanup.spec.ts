import { describe, expect, it, vi } from 'vitest'

vi.mock('vscode', () => ({
  EventEmitter: class {
    readonly event = vi.fn()
    fire(): void {}
    dispose(): void {}
  },
}))

import { DshRuntime } from '../src/runtime.ts'
import type { RuntimeLaunchPreparation } from '../src/runtime-launch.ts'

interface RuntimeCleanupAccess {
  launchPreparation: RuntimeLaunchPreparation | undefined
  releaseLaunchPreparation(): Promise<void>
}

describe('runtime launch cleanup', () => {
  it('shares an in-flight asynchronous cleanup with every waiter', async () => {
    let finishDisposal: (() => void) | undefined
    const dispose = vi.fn(() => new Promise<void>(resolve => { finishDisposal = resolve }))
    const runtime = new DshRuntime({} as never, { appendLine: vi.fn() } as never)
    const cleanup = runtime as unknown as RuntimeCleanupAccess
    cleanup.launchPreparation = { transformArguments: args => [...args], dispose }

    const fromExitHandler = cleanup.releaseLaunchPreparation()
    const fromStop = cleanup.releaseLaunchPreparation()
    let stopFinished = false
    void fromStop.then(() => { stopFinished = true })
    await Promise.resolve()

    expect(dispose).toHaveBeenCalledTimes(1)
    expect(stopFinished).toBe(false)

    finishDisposal?.()
    await Promise.all([fromExitHandler, fromStop])
    expect(stopFinished).toBe(true)

    await cleanup.releaseLaunchPreparation()
    expect(dispose).toHaveBeenCalledTimes(1)
  })
})
