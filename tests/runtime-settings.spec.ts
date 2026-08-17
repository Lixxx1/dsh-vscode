import { describe, expect, it } from 'vitest'
import {
  parseRuntimeSetting,
  runtimeSettingFields,
  settingConstantOptions,
  type SettingsNamespace,
} from '../src/runtime-settings.js'

const namespace: SettingsNamespace = {
  ns: 'example-plugin',
  schema: {
    uid: 8,
    refs: {
      '1': { type: 'const', value: 'off' },
      '2': { type: 'const', value: 'on' },
      '3': { type: 'union', list: [1, 2] },
      '4': { type: 'number', meta: { min: 1, max: 10 } },
      '5': { type: 'string', meta: { role: 'secret' } },
      '6': { type: 'object', dict: { limit: 4 } },
      '8': { type: 'object', dict: { mode: 3, nested: 6, token: 5 } },
    },
  },
  value: { mode: 'on', nested: { limit: 4 } },
  base: { mode: 'off', nested: { limit: 2 } },
  user: { mode: 'on', nested: { limit: 4 } },
  applies: 'restart',
  secrets: [{ path: ['token'], set: true }],
  revision: 7,
}

describe('runtime settings schemas', () => {
  it('flattens Schemastery object fields while preserving overrides and redacted secrets', () => {
    const fields = runtimeSettingFields(namespace)

    expect(fields.map(field => field.path.join('.'))).toEqual(['mode', 'nested.limit', 'token'])
    expect(fields[0]).toMatchObject({ value: 'on', inherited: 'off', overridden: true })
    expect(fields[2]).toMatchObject({ value: undefined, overridden: false, secretSet: true })
    expect(settingConstantOptions(fields[0]!, namespace.schema)).toEqual(['off', 'on'])
  })

  it('parses and validates typed setting input', () => {
    const numberField = runtimeSettingFields(namespace)[1]!
    expect(parseRuntimeSetting(numberField, '8')).toBe(8)
    expect(() => parseRuntimeSetting(numberField, '0')).toThrow('at least 1')
    expect(() => parseRuntimeSetting(numberField, 'not-a-number')).toThrow('valid number')
  })
})
