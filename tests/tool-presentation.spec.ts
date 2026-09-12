import { describe, expect, it } from 'vitest'
import { ConversationProjector, type DshEvent } from '../src/conversation.js'
import { diffsFromMeta, fileMutation, presentToolCall, presentToolResult } from '../src/tool-presentation.js'

function result(meta: unknown, text = 'done', failed = false): DshEvent {
  return { type: 'tool/result', seq: 2, time: 2, data: { turn: 1, meta, message: {
    source: { kind: 'tool', callId: 'call' },
    content: [{ type: 'tool-result', toolCallId: 'call', isError: failed, content: [{ type: 'text', text }] }],
  } } }
}

describe('0.1.2 built-in tool presentation', () => {
  const args = { file_path: 'app.ts', old_string: 'old', new_string: 'new' }
  const diffs = [{ path: 'app.ts', oldText: 'context\nold\ncontext', newText: 'context\nnew\ncontext' }]

  it('uses applied contextual hunks, identically for live events and history without legacy views', () => {
    const entries = [
      { type: 'tool/call', seq: 1, time: 1, data: { turn: 1, callId: 'call', name: 'edit', arguments: JSON.stringify(args) } },
      result({ diffs }),
    ]
    const live = new ConversationProjector()
    entries.forEach(entry => live.apply(entry))
    const history = new ConversationProjector()
    history.reset(entries)
    expect(history.messages()).toEqual(live.messages())
    expect(live.messages()[0]).toMatchObject({ text: 'edit', failed: false,
      callView: { card: 'diff', title: 'Edit app.ts', diffs: [{ path: 'app.ts', oldText: 'old', newText: 'new' }] },
      resultView: { card: 'diff', diffs }, rawResult: 'done' })
  })

  it('never shows a requested edit as applied after failure, a no-op or malformed metadata', () => {
    for (const meta of [undefined, { diffs: [] }, { diffs: [null] }]) {
      expect(presentToolResult('edit', args, result(meta), false)?.card).toBe('generic')
    }
    const projector = new ConversationProjector()
    projector.apply({ type: 'tool/call', seq: 1, time: 1, data: { callId: 'call', name: 'edit', arguments: JSON.stringify(args) } })
    projector.apply(result({ diffs }, 'Permission denied', true))
    expect(projector.messages()[0]).toMatchObject({ failed: true,
      resultView: { card: 'generic', content: [{ type: 'text', text: 'Permission denied' }] } })
  })

  it('only presents a whole-file creation when the official result says it created a file', () => {
    const args = { file_path: 'new.ts', content: 'new\n' }
    const envelope = (operation: string) => `<path>new.ts</path>\n<type>file</type>\n<content>\n${operation} file\n</content>`
    expect(presentToolResult('write', args, result({ diffs: [] }, envelope('Created')), false)).toMatchObject({
      card: 'diff', diffs: [{ path: 'new.ts', oldText: null, newText: 'new\n' }],
    })
    expect(presentToolResult('write', args, result({ diffs: [] }, envelope('Updated')), false)?.card).toBe('generic')
    expect(presentToolResult('write', args, result({}, `Quoted:\n${envelope('Created')}`), false)?.card).toBe('generic')
  })

  it('reconstructs line-numbered Read and clickable search results', () => {
    const read = { path: 'app.ts', offset: 42, lines: [{ number: 42, text: 'hello' }], totalLines: 80 }
    expect(presentToolResult('read', { file_path: 'app.ts', offset: 42 }, result(read), false)).toMatchObject({ card: 'read', ...read })
    expect(presentToolCall('read', { file_path: 'app.ts', offset: 42 })).toMatchObject({ locations: [{ path: 'app.ts', line: 42 }] })
    const paths = { shape: 'paths', paths: ['app.ts', 'other.ts'], total: 2, truncated: false }
    expect(presentToolResult('glob', { pattern: '*.ts' }, result(paths), false)).toMatchObject({ card: 'search', ...paths })
    const matches = { shape: 'matches', files: [{ path: 'app.ts', matches: [{ lineNumber: 42, line: 'hello' }] }], total: 1, truncated: false }
    expect(presentToolResult('grep', { pattern: 'hello' }, result(matches), false)).toMatchObject({ card: 'search', ...matches })
    expect(presentToolResult('read', {}, result({ ...read, lines: [{ number: -1, text: 'bad' }] }), false)?.card).toBe('generic')
    expect(presentToolResult('grep', {}, result({ ...matches, files: [null] }), false)?.card).toBe('generic')
  })

  it('preserves shell output and does not interpret arbitrary plugin metadata as filesystem changes', () => {
    for (const name of ['bash', 'pwsh']) {
      expect(presentToolResult(name, { command: 'node app.js' }, result(undefined, 'output\n[exit code: 1]'), false)).toMatchObject({
        card: 'terminal', title: 'node app.js', output: 'output', exitCode: 1,
      })
    }
    expect(presentToolResult('mcp__custom__edit', args, result({ diffs }), false)?.card).toBe('generic')
    expect(fileMutation('mcp__custom__edit', args)).toBeUndefined()
    expect(fileMutation('edit', '{broken')).toBeUndefined()
    expect(diffsFromMeta({ diffs: [...diffs, { path: 'app.ts', newText: 'missing old text' }] })).toBeUndefined()
  })

  it.each(['bash', 'pwsh'])('restores %s working directories and does not give background receipts an exit status', name => {
    expect(presentToolCall(name, { command: 'run', workdir: 'C:\\project', cwd: 'old', description: 'Build project' })).toEqual({
      card: 'terminal', title: 'run', cwd: 'C:\\project', description: 'Build project',
    })
    expect(presentToolCall(name, { command: 'run', cwd: '/legacy' })).toMatchObject({ cwd: '/legacy' })
    const args = { command: 'run server', run_in_background: true, description: 'Start local server' }
    expect(presentToolCall(name, args)).toEqual({ card: 'generic', title: 'run server', content: [{ type: 'text', text: 'Start local server' }] })
    expect(presentToolResult(name, args, result(undefined, 'Started background job bash-1'), false)).toEqual({
      card: 'generic', title: 'run server', content: [{ type: 'text', text: 'Started background job bash-1' }],
    })
    expect(presentToolResult(name, { command: 'bad' }, result(undefined, 'spawn failed'), true)).not.toHaveProperty('exitCode')
  })

  it.each(['bash', 'pwsh'])('recovers %s final exit/signal markers without stripping timeout or sandbox notices', name => {
    const view = (text: string) => presentToolResult(name, { command: 'run' }, result(undefined, text), false)
    expect(view('output')).toMatchObject({ output: 'output', exitCode: 0 })
    expect(view('out\n[exit code: 7]')).toMatchObject({ output: 'out', exitCode: 7 })
    expect(view('out\n[timed out after 10ms]\n[killed by signal: SIGTERM]')).toEqual({
      card: 'terminal', title: 'run', output: 'out\n[timed out after 10ms]', signal: 'SIGTERM',
    })
    expect(view('out\n[sandbox: file access denied under read-only mode]\n[exit code: 1]')).toMatchObject({
      output: 'out\n[sandbox: file access denied under read-only mode]', exitCode: 1,
    })
    expect(view('An embedded [exit code: 9]')).toMatchObject({ output: 'An embedded [exit code: 9]', exitCode: 0 })
    expect(view('out\n[exit code: 9]\nmore output')).toMatchObject({ output: 'out\n[exit code: 9]\nmore output', exitCode: 0 })
  })

  it('keeps original shell output available while live and replayed terminal cards show the same status', () => {
    const entries = [
      { type: 'tool/call', seq: 1, time: 1, data: { callId: 'call', name: 'bash', arguments: JSON.stringify({ command: 'run', workdir: '/project' }) } },
      result(undefined, 'failure output\n[exit code: 2]'),
    ]
    const live = new ConversationProjector(); entries.forEach(entry => live.apply(entry))
    const replay = new ConversationProjector(); replay.reset(entries)
    expect(replay.messages()).toEqual(live.messages())
    expect(live.messages()[0]).toMatchObject({
      callView: { cwd: '/project' }, resultView: { output: 'failure output', exitCode: 2 }, rawResult: 'failure output\n[exit code: 2]',
    })
  })
})
