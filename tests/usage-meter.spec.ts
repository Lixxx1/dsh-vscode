import { describe, expect, it } from 'vitest'
import { unavailableUsageMeterState, usageMeterStateOf } from '../src/usage-meter.js'

describe('Usage meter state', () => {
  it('uses the official projected context value and exposes its breakdown', () => {
    expect(usageMeterStateOf({
      contextPressure: { pressureTokens: 24_000, projectedTokens: 32_768, contextWindow: 131_072 },
      contextBreakdown: { systemTokens: 2_000, toolsTokens: 4_000, messageTokens: 8_000 },
    })).toEqual({
      available: true,
      percent: 25,
      usedTokens: 32_768,
      contextWindow: 131_072,
      breakdown: { systemTokens: 2_000, toolsTokens: 4_000, messageTokens: 8_000 },
    })
  })

  it('falls back to pressure tokens and clamps occupancy at 100 percent', () => {
    expect(usageMeterStateOf({
      contextPressure: { pressureTokens: 150, contextWindow: 100 },
    })).toMatchObject({ available: true, percent: 100, usedTokens: 150, contextWindow: 100 })
  })

  it('keeps session usage and stats when the route has no context capacity', () => {
    expect(usageMeterStateOf({
      tokenUsage: {
        uncachedInputTokens: 10,
        outputTokens: 20,
        cacheReadTokens: 30,
        cacheWriteTokens: 40,
      },
      sessionStats: {
        turns: 1,
        steps: 2,
        llmMs: 3,
        toolMs: 4,
        ttftMs: 5,
        ttftSteps: 1,
        decodeMs: 6,
        decodeTokens: 7,
      },
    })).toEqual({
      ...unavailableUsageMeterState(),
      tokenUsage: {
        uncachedInputTokens: 10,
        outputTokens: 20,
        cacheReadTokens: 30,
        cacheWriteTokens: 40,
      },
      sessionStats: {
        turns: 1,
        steps: 2,
        llmMs: 3,
        toolMs: 4,
        ttftMs: 5,
        ttftSteps: 1,
        decodeMs: 6,
        decodeTokens: 7,
      },
    })
  })

  it('hides malformed projection values', () => {
    expect(usageMeterStateOf({
      contextPressure: { projectedTokens: -1, contextWindow: '128k' },
      tokenUsage: { outputTokens: 10 },
    })).toEqual(unavailableUsageMeterState())
  })
})
