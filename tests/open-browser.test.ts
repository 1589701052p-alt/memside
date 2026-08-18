import { describe, test, expect } from 'bun:test'
import { openBrowser, isMemsideHolder, shouldAutoOpen, type OpenBrowserCtx } from '@/exe/open-browser'

function fakeCtx(platform: NodeJS.Platform, capture: { cmd: string[] | null }, result: { stdout: string; exitCode: number | null } | (() => Promise<{ stdout: string; exitCode: number | null }>)): OpenBrowserCtx {
  return {
    platform,
    spawn: async (cmd: string[]) => {
      capture.cmd = cmd
      return typeof result === 'function' ? await result() : result
    },
  }
}

describe('openBrowser', () => {
  test('win32 用 cmd /c start 打开', async () => {
    const cap: { cmd: string[] | null } = { cmd: null }
    const ok = await openBrowser('http://127.0.0.1:7777', fakeCtx('win32', cap, { stdout: '', exitCode: 0 }))
    expect(ok).toBe(true)
    expect(cap.cmd).toEqual(['cmd', '/c', 'start', '', 'http://127.0.0.1:7777'])
  })

  test('darwin 用 open 打开', async () => {
    const cap: { cmd: string[] | null } = { cmd: null }
    const ok = await openBrowser('http://127.0.0.1:7777', fakeCtx('darwin', cap, { stdout: '', exitCode: 0 }))
    expect(ok).toBe(true)
    expect(cap.cmd).toEqual(['open', 'http://127.0.0.1:7777'])
  })

  test('linux 用 xdg-open 打开', async () => {
    const cap: { cmd: string[] | null } = { cmd: null }
    const ok = await openBrowser('http://127.0.0.1:7777', fakeCtx('linux', cap, { stdout: '', exitCode: 0 }))
    expect(ok).toBe(true)
    expect(cap.cmd).toEqual(['xdg-open', 'http://127.0.0.1:7777'])
  })

  test('spawn 非零退出返回 false 不抛', async () => {
    const ok = await openBrowser('http://127.0.0.1:7777', fakeCtx('linux', { cmd: null }, { stdout: '', exitCode: 1 }))
    expect(ok).toBe(false)
  })

  test('spawn 抛错返回 false 不抛', async () => {
    const cap: { cmd: string[] | null } = { cmd: null }
    const ok = await openBrowser('http://127.0.0.1:7777', fakeCtx('linux', cap, async () => { throw new Error('no xdg-open') }))
    expect(ok).toBe(false)
  })
})

describe('isMemsideHolder', () => {
  test('自身 PID 判 false', () => {
    expect(isMemsideHolder('C:\\LOCALAPPDATA\\memside\\memside.exe', 1000, 1000)).toBe(false)
  })

  test('命令行含 memside 判 true', () => {
    expect(isMemsideHolder('C:\\Users\\me\\AppData\\Local\\memside\\memside.exe', 1000, 2000)).toBe(true)
    expect(isMemsideHolder('/home/me/projects/memside/src/exe/launcher.ts', 1000, 2000)).toBe(true)
  })

  test('命令行不含 memside 判 false', () => {
    expect(isMemsideHolder('C:\\Program Files\\other-app\\server.exe', 1000, 2000)).toBe(false)
  })

  test('空 cmdline 判 false', () => {
    expect(isMemsideHolder('', 1000, 2000)).toBe(false)
  })
})

describe('shouldAutoOpen', () => {
  test('MEMSIDE_NO_OPEN 未设返回 true', () => {
    const prev = process.env.MEMSIDE_NO_OPEN
    delete process.env.MEMSIDE_NO_OPEN
    expect(shouldAutoOpen()).toBe(true)
    if (prev !== undefined) process.env.MEMSIDE_NO_OPEN = prev
  })

  test('MEMSIDE_NO_OPEN=1 返回 false', () => {
    const prev = process.env.MEMSIDE_NO_OPEN
    process.env.MEMSIDE_NO_OPEN = '1'
    expect(shouldAutoOpen()).toBe(false)
    if (prev !== undefined) process.env.MEMSIDE_NO_OPEN = prev
    else delete process.env.MEMSIDE_NO_OPEN
  })
})
