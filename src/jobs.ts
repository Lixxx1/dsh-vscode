export type JobStatus = 'running' | 'stopping' | 'completed' | 'killed' | 'failed'

export interface JobItem {
  id: string
  kind: string
  label: string
  status: JobStatus
  detail?: string
  startedAt: number
  finishedAt?: number
}

function statusOf(value: unknown): JobStatus | undefined {
  return value === 'running' || value === 'stopping' || value === 'completed' || value === 'killed' || value === 'failed'
    ? value
    : undefined
}

/** Narrows the authoritative DSH session/jobs snapshot before it reaches the Webview. */
export function jobsSnapshotOf(value: unknown): JobItem[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((candidate): JobItem[] => {
    if (typeof candidate !== 'object' || candidate === null) return []
    const item = candidate as Record<string, unknown>
    const status = statusOf(item.status)
    if (typeof item.id !== 'string'
      || typeof item.kind !== 'string'
      || typeof item.label !== 'string'
      || status === undefined
      || typeof item.startedAt !== 'number'
      || !Number.isFinite(item.startedAt)) return []
    return [{
      id: item.id,
      kind: item.kind,
      label: item.label,
      status,
      startedAt: item.startedAt,
      ...(typeof item.detail === 'string' ? { detail: item.detail } : {}),
      ...(typeof item.finishedAt === 'number' && Number.isFinite(item.finishedAt)
        ? { finishedAt: item.finishedAt }
        : {}),
    }]
  })
}
