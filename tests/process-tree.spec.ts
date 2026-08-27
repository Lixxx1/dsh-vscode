import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { terminateProcessTree } from '../src/process-tree.ts'

function child(pid = 42) {
  return {
    pid,
    exitCode: null,
    signalCode: null,
    kill: vi.fn(() => true),
  }
}

describe('process tree termination', () => {
  it('uses normal Node signals outside Windows', () => {
    const process = child()
    expect(terminateProcessTree(process, 'SIGTERM', { platform: 'linux' })).toBe(true)
    expect(process.kill).toHaveBeenCalledWith('SIGTERM')
  })

  it('uses taskkill to terminate the complete Windows process tree', () => {
    const process = child(1234)
    const taskkill = new EventEmitter()
    const spawnProcess = vi.fn(() => taskkill)

    expect(terminateProcessTree(process, 'SIGTERM', {
      platform: 'win32',
      spawnProcess: spawnProcess as never,
      env: { SystemRoot: 'C:\\Windows' },
    })).toBe(true)
    expect(spawnProcess).toHaveBeenCalledWith(
      'C:\\Windows\\System32\\taskkill.exe',
      ['/PID', '1234', '/T', '/F'],
      { stdio: 'ignore', windowsHide: true },
    )
    expect(process.kill).not.toHaveBeenCalled()
  })

  it('falls back to killing the wrapper when taskkill fails', () => {
    const process = child()
    const taskkill = new EventEmitter()
    const spawnProcess = vi.fn(() => taskkill)
    terminateProcessTree(process, 'SIGTERM', {
      platform: 'win32',
      spawnProcess: spawnProcess as never,
      env: { windir: 'C:\\Windows' },
    })

    taskkill.emit('close', 1)
    expect(process.kill).toHaveBeenCalledWith('SIGKILL')
  })

  it('does not search the current directory when the Windows system root is unavailable', () => {
    const process = child()
    const spawnProcess = vi.fn()

    expect(terminateProcessTree(process, 'SIGTERM', {
      platform: 'win32',
      spawnProcess: spawnProcess as never,
      env: {},
    })).toBe(true)
    expect(spawnProcess).not.toHaveBeenCalled()
    expect(process.kill).toHaveBeenCalledWith('SIGKILL')
  })
})
