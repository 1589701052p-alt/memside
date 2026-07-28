import { test, expect } from 'bun:test'
import { findPortHolders, promptReclaim, reclaim, type PortCheckCtx, type ReclaimCtx } from '@/launch/portCheck'

// 端口占用防呆（2026-07-28-port-reclaim-guard）：跨平台端口查询纯函数层。
// 平台/spawn 全注入，不碰真实系统命令。

/** 造一个按命令返回固定 stdout 的假 spawn。键为完整命令字符串。 */
function fakeSpawn(map: Record<string, string>): PortCheckCtx['spawn'] {
  return async (cmd: string[]) => {
    const key = cmd.join(' ')
    return { stdout: map[key] ?? '', exitCode: map[key] !== undefined ? 0 : 1 }
  }
}

test('Windows: parses LISTENING PID from netstat + cmdline from wmic', async () => {
  const ctx: PortCheckCtx = {
    platform: 'win32',
    spawn: fakeSpawn({
      'netstat -ano':
        '  TCP    127.0.0.1:7777         0.0.0.0:0              LISTENING       18196\r\n' +
        '  TCP    127.0.0.1:5173         0.0.0.0:0              LISTENING       21044\r\n',
      'wmic process where ProcessId=18196 get CommandLine /value':
        'CommandLine=bun run src/cli.ts start\r\n',
      'wmic process where ProcessId=21044 get CommandLine /value':
        'CommandLine=node vite/bin/vite.js\r\n',
    }),
  }
  const holders = await findPortHolders([7777, 5173], ctx)
  expect(holders).toContainEqual({ port: 7777, pid: 18196, cmdline: 'bun run src/cli.ts start' })
  expect(holders).toContainEqual({ port: 5173, pid: 21044, cmdline: 'node vite/bin/vite.js' })
})

test('Windows: unoccupied port yields no holder', async () => {
  const ctx: PortCheckCtx = {
    platform: 'win32',
    spawn: fakeSpawn({ 'netstat -ano': '  TCP    127.0.0.1:9999  0.0.0.0:0  LISTENING  1\r\n' }),
  }
  const holders = await findPortHolders([7777], ctx)
  expect(holders).toEqual([])
})

test('Windows: wmic failure leaves cmdline empty, PID still listed', async () => {
  const ctx: PortCheckCtx = {
    platform: 'win32',
    spawn: fakeSpawn({
      'netstat -ano': '  TCP    127.0.0.1:7777  0.0.0.0:0  LISTENING  18196\r\n',
      'wmic process where ProcessId=18196 get CommandLine /value': '',
    }),
  }
  const holders = await findPortHolders([7777], ctx)
  expect(holders).toEqual([{ port: 7777, pid: 18196, cmdline: '' }])
})

test('Windows: same port held by multiple PIDs all listed', async () => {
  const ctx: PortCheckCtx = {
    platform: 'win32',
    spawn: fakeSpawn({
      'netstat -ano':
        '  TCP    0.0.0.0:7777  0.0.0.0:0  LISTENING  100\r\n' +
        '  TCP    [::]:7777     [::]:0     LISTENING  200\r\n',
      'wmic process where ProcessId=100 get CommandLine /value': 'CommandLine=a\r\n',
      'wmic process where ProcessId=200 get CommandLine /value': 'CommandLine=b\r\n',
    }),
  }
  const holders = await findPortHolders([7777], ctx)
  expect(holders).toContainEqual({ port: 7777, pid: 100, cmdline: 'a' })
  expect(holders).toContainEqual({ port: 7777, pid: 200, cmdline: 'b' })
})

test('posix: parses PIDs from lsof + cmdline from ps', async () => {
  const ctx: PortCheckCtx = {
    platform: 'linux',
    spawn: fakeSpawn({
      'lsof -ti:7777': '18196\n21044\n',
      'ps -p 18196 -o command=': 'bun run src/cli.ts start\n',
      'ps -p 21044 -o command=': 'node vite/bin/vite.js\n',
    }),
  }
  const holders = await findPortHolders([7777], ctx)
  expect(holders).toContainEqual({ port: 7777, pid: 18196, cmdline: 'bun run src/cli.ts start' })
  expect(holders).toContainEqual({ port: 7777, pid: 21044, cmdline: 'node vite/bin/vite.js' })
})

test('posix: unoccupied port yields no holder', async () => {
  const ctx: PortCheckCtx = {
    platform: 'darwin',
    spawn: fakeSpawn({ 'lsof -ti:7777': '' }),
  }
  const holders = await findPortHolders([7777], ctx)
  expect(holders).toEqual([])
})

test('any platform: spawn failure degrades to empty (does not throw)', async () => {
  const ctx: PortCheckCtx = {
    platform: 'win32',
    spawn: async () => { throw new Error('netstat not found') },
  }
  const holders = await findPortHolders([7777], ctx)
  expect(holders).toEqual([])
})

test('promptReclaim: empty holders returns true (no prompt)', async () => {
  const ctx: ReclaimCtx = { isTTY: true, readline: async () => 'n' }
  expect(await promptReclaim([], ctx)).toBe(true)
})

test('promptReclaim: non-TTY prints and returns false', async () => {
  const calls: string[] = []
  const origLog = console.log
  console.log = (s: string) => { calls.push(s) }
  const ctx: ReclaimCtx = { isTTY: false, readline: async () => 'y' }
  try {
    expect(await promptReclaim([{ port: 7777, pid: 1, cmdline: 'x' }], ctx)).toBe(false)
  } finally {
    console.log = origLog
  }
  expect(calls.some((s) => s.includes('7777'))).toBe(true)
})

test('promptReclaim: TTY y/yes returns true', async () => {
  for (const ans of ['y', 'Y', ' yes ', 'YES']) {
    const ctx: ReclaimCtx = { isTTY: true, readline: async () => ans }
    expect(await promptReclaim([{ port: 7777, pid: 1, cmdline: 'x' }], ctx)).toBe(true)
  }
})

test('promptReclaim: TTY n/empty/other returns false', async () => {
  for (const ans of ['n', '', 'no', 'x']) {
    const ctx: ReclaimCtx = { isTTY: true, readline: async () => ans }
    expect(await promptReclaim([{ port: 7777, pid: 1, cmdline: 'x' }], ctx)).toBe(false)
  }
})

test('reclaim: Windows calls taskkill per unique PID', async () => {
  const calls: string[][] = []
  const ctx: PortCheckCtx = {
    platform: 'win32',
    spawn: async (cmd: string[]) => { calls.push(cmd); return { stdout: '', exitCode: 0 } },
  }
  // 同 PID 占两端口 -> 只杀一次
  await reclaim(
    [
      { port: 7777, pid: 18196, cmdline: 'a' },
      { port: 5173, pid: 18196, cmdline: 'a' },
      { port: 5173, pid: 21044, cmdline: 'b' },
    ],
    ctx,
  )
  expect(calls).toEqual([
    ['taskkill', '//PID', '18196', '//F'],
    ['taskkill', '//PID', '21044', '//F'],
  ])
})

test('reclaim: posix uses process.kill SIGKILL', async () => {
  const killed: number[] = []
  const origKill = process.kill
  process.kill = ((pid: number, sig?: string | number) => { killed.push(pid); return true }) as typeof process.kill
  const ctx: PortCheckCtx = { platform: 'linux', spawn: async () => ({ stdout: '', exitCode: 0 }) }
  try {
    await reclaim([{ port: 7777, pid: 42, cmdline: 'x' }], ctx)
  } finally {
    process.kill = origKill
  }
  expect(killed).toEqual([42])
})

test('reclaim: kill failure warns but does not throw', async () => {
  const ctx: PortCheckCtx = {
    platform: 'win32',
    spawn: async () => { throw new Error('access denied') },
  }
  // 不抛即通过
  await reclaim([{ port: 7777, pid: 1, cmdline: '' }], ctx)
})
