import { describe, expect, it } from 'vitest'
import { withIdeContext } from '../src/ide-context.js'
import { queueSnapshotOf } from '../src/queue.js'

describe('queueSnapshotOf', () => {
  it('projects queued and steering messages while hiding captured IDE context', () => {
    const contextual = withIdeContext('Fix the parser', {
      activeFile: { kind: 'file', path: 'src/parser.ts' },
      pinned: [],
      mentions: [],
    })
    const snapshot = queueSnapshotOf([
      {
        id: 'queued-1',
        placement: 'queued',
        message: { id: 'message-1', content: [{ type: 'text', text: contextual }] },
      },
      {
        id: 'steer-1',
        placement: 'steering',
        message: { id: 'message-2', content: [{ type: 'text', text: 'Use the smaller fix' }] },
      },
      {
        id: 'context-1',
        placement: 'context',
        message: { id: 'message-3', content: [{ type: 'text', text: 'hidden plugin context' }] },
      },
    ])

    expect(snapshot.items).toEqual([
      { id: 'queued-1', placement: 'queued', preview: 'Fix the parser', text: 'Fix the parser' },
      { id: 'steer-1', placement: 'steering', preview: 'Use the smaller fix', text: 'Use the smaller fix' },
    ])
    expect(snapshot.rawText.get('queued-1')).toBe(contextual)
  })

  it('keeps attachment messages visible but non-editable', () => {
    expect(queueSnapshotOf([{
      id: 'queued-image',
      placement: 'queued',
      message: { content: [{ type: 'image', name: 'diagram.png' }, { type: 'text', text: 'Inspect this' }] },
    }]).items).toEqual([{
      id: 'queued-image',
      placement: 'queued',
      preview: '[image] Inspect this',
      text: null,
    }])
  })
})
