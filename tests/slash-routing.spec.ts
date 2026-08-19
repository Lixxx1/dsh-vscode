import { describe, expect, it } from 'vitest'
import { routeSlashInput } from '../src/slash-routing.js'

const commands = [{ name: 'permission' }, { name: 'compact' }]
const skills = [{ name: 'review-code' }, { name: 'explain-project' }]

describe('slash input routing', () => {
  it('routes official commands before skills', () => {
    expect(routeSlashInput('/compact', commands, skills)).toEqual({
      kind: 'command',
      name: 'compact',
      token: '/compact',
    })
  })

  it('routes a skill invocation through the normal prompt path', () => {
    expect(routeSlashInput('/review-code focus on security', commands, skills)).toEqual({
      kind: 'skill',
      name: 'review-code',
      token: '/review-code',
    })
  })

  it('rejects unknown slash tokens without affecting ordinary prompts', () => {
    expect(routeSlashInput('/not-installed', commands, skills)).toEqual({
      kind: 'unknown',
      token: '/not-installed',
    })
    expect(routeSlashInput('explain this file', commands, skills)).toEqual({ kind: 'prompt' })
  })

  it('keeps command precedence if a runtime exposes a duplicate name', () => {
    expect(routeSlashInput('/compact', commands, [...skills, { name: 'compact' }]).kind).toBe('command')
  })
})
