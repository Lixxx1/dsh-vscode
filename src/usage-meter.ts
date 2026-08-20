export interface TokenUsageState {
  uncachedInputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

export interface SessionStatsState {
  turns: number
  steps: number
  llmMs: number
  toolMs: number
  ttftMs: number
  ttftSteps: number
  decodeMs: number
  decodeTokens: number
}

export interface ContextBreakdownState {
  systemTokens: number
  toolsTokens: number
  messageTokens: number
}

export interface UsageMeterState {
  available: boolean
  percent: number
  usedTokens: number
  contextWindow: number
  breakdown?: ContextBreakdownState
  tokenUsage?: TokenUsageState
  sessionStats?: SessionStatsState
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function countOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

function countsOf<T extends object>(
  value: unknown,
  keys: readonly (keyof T)[],
): T | undefined {
  const record = recordOf(value)
  if (record === undefined) return undefined
  const result: Record<string, number> = {}
  for (const key of keys) {
    const count = countOf(record[String(key)])
    if (count === undefined) return undefined
    result[String(key)] = count
  }
  return result as T
}

export function unavailableUsageMeterState(): UsageMeterState {
  return { available: false, percent: 0, usedTokens: 0, contextWindow: 0 }
}

export function usageMeterStateOf(values: Record<string, unknown> | undefined): UsageMeterState {
  const tokenUsage = countsOf<TokenUsageState>(values?.tokenUsage, [
    'uncachedInputTokens',
    'outputTokens',
    'cacheReadTokens',
    'cacheWriteTokens',
  ])
  const sessionStats = countsOf<SessionStatsState>(values?.sessionStats, [
    'turns',
    'steps',
    'llmMs',
    'toolMs',
    'ttftMs',
    'ttftSteps',
    'decodeMs',
    'decodeTokens',
  ])
  const breakdown = countsOf<ContextBreakdownState>(values?.contextBreakdown, [
    'systemTokens',
    'toolsTokens',
    'messageTokens',
  ])
  const pressure = recordOf(values?.contextPressure)
  const projectedTokens = countOf(pressure?.projectedTokens)
  const pressureTokens = countOf(pressure?.pressureTokens)
  const usedTokens = projectedTokens ?? pressureTokens
  const contextWindow = countOf(pressure?.contextWindow)
  const common = {
    ...(breakdown === undefined ? {} : { breakdown }),
    ...(tokenUsage === undefined ? {} : { tokenUsage }),
    ...(sessionStats === undefined ? {} : { sessionStats }),
  }
  if (usedTokens === undefined || contextWindow === undefined || contextWindow === 0) {
    return { ...unavailableUsageMeterState(), ...common }
  }
  return {
    available: true,
    percent: Math.min(100, Math.round((usedTokens / contextWindow) * 100)),
    usedTokens,
    contextWindow,
    ...common,
  }
}
