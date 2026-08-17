import { describe, expect, it } from 'vitest'
import { jobsSnapshotOf } from '../src/jobs.js'

describe('jobsSnapshotOf', () => {
  it('keeps the official background job view and rejects malformed rows', () => {
    expect(jobsSnapshotOf([
      {
        id: 'subagent-1',
        kind: 'subagent',
        label: 'Review the API',
        status: 'running',
        startedAt: 100,
      },
      {
        id: 'bash-2',
        kind: 'bash',
        label: 'npm test',
        status: 'failed',
        detail: 'exit code: 1',
        startedAt: 200,
        finishedAt: 250,
      },
      { id: 'bad', kind: 'bash', label: 'bad', status: 'unknown', startedAt: 1 },
    ])).toEqual([
      {
        id: 'subagent-1',
        kind: 'subagent',
        label: 'Review the API',
        status: 'running',
        startedAt: 100,
      },
      {
        id: 'bash-2',
        kind: 'bash',
        label: 'npm test',
        status: 'failed',
        detail: 'exit code: 1',
        startedAt: 200,
        finishedAt: 250,
      },
    ])
  })
})
