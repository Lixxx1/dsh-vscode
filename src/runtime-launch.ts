export interface RuntimeLaunchContext {
  readonly workspacePath: string
  readonly configuredExecutable: string
  readonly configuredArguments: readonly string[]
}

/**
 * One managed-runtime launch overlay. Returning a preparation opts out of
 * external runtime reuse for that launch.
 */
export interface RuntimeLaunchPreparation {
  transformArguments(args: readonly string[], dshVersion: string | undefined): readonly string[]
  readonly environment?: Readonly<Record<string, string>>
  dispose?(): void | Promise<void>
}

export interface RuntimeLaunchContributor {
  prepare(context: RuntimeLaunchContext): Promise<RuntimeLaunchPreparation | undefined>
}

export function applyRuntimeLaunchPreparation(
  args: readonly string[],
  dshVersion: string | undefined,
  preparation: RuntimeLaunchPreparation | undefined,
): string[] {
  return preparation === undefined
    ? [...args]
    : [...preparation.transformArguments(args, dshVersion)]
}
