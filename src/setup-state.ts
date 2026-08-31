export type SetupKind = 'workspace' | 'dsh' | 'api-key' | null

type ChatPhase = 'loading' | 'ready' | 'error'

const MISSING_DSH = /(?:spawn(?:sync)?\s+dsh(?:\.cmd)?\s+enoent|enoent[^\n]*\bdsh(?:\.cmd)?\b|\bdsh(?:\.cmd)?\b[^\n]*(?:not found|not recognized)|could not (?:find|launch|start)[^\n]*\bdsh\b)/i
const MISSING_API_KEY = /(?:deepseek_api_key|api key|unauthori[sz]ed|authentication (?:failed|required)|invalid (?:credential|token))/i

/** Maps startup failures to the next useful setup action without hiding the original error. */
export function setupKindFor(cwd: string, phase: ChatPhase, statusText: string): SetupKind {
  if (cwd.trim() === '') return 'workspace'
  if (phase !== 'error') return null
  if (MISSING_DSH.test(statusText)) return 'dsh'
  if (MISSING_API_KEY.test(statusText)) return 'api-key'
  return null
}
