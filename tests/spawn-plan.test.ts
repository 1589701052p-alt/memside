import { test, expect } from 'bun:test'
import { buildSpawnPlan } from '@/launch/spawnPlan'

// 一键启动（2026-07-28-one-click-launch）：dev 编排的端口/命令决策纯函数层。
// 命令首元素必须是调用方传入的真 bun 路径（process.execPath）：Windows 上
// npm shim 的 'bun' 会被 cmd.exe 包装，kill 只杀壳会孤儿化子进程（实测）。
const BUN = '/fake/bun.exe'

test('default plan: daemon via cli start on 7777, web via vite js entry, both under bunPath', () => {
  const plan = buildSpawnPlan({}, BUN)
  expect(plan.port).toBe(7777)
  expect(plan.daemon.cmd).toEqual([BUN, 'src/cli.ts', 'start'])
  expect(plan.web.cmd).toEqual([BUN, 'node_modules/vite/bin/vite.js'])
})

test('MEMSIDE_PORT override is reflected in plan.port', () => {
  expect(buildSpawnPlan({ MEMSIDE_PORT: '8888' }, BUN).port).toBe(8888)
})
