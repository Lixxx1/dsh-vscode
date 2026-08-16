export const DEEPSEEK_API_KEY_SECRET = 'deepseekHarness.deepseekApiKey'

export function normalizeDeepSeekApiKey(value: string): string {
  const trimmed = value.trim()
  if (trimmed.length === 0) throw new Error('Paste or enter a DeepSeek API key.')
  if (!/^[\x21-\x7E]+$/.test(trimmed)) {
    throw new Error('The API key must contain only printable ASCII characters without spaces.')
  }
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(trimmed)) {
    throw new Error('Paste only the API key value, not DEEPSEEK_API_KEY=…')
  }
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    throw new Error('Paste the API key without surrounding quotes.')
  }
  return trimmed
}
