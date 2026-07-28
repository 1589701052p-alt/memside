import { test, expect } from 'bun:test'
import { buildSpawnPlan } from '@/launch/spawnPlan'

// 一键启动（2026-07-28-one-click-launch）：dev 编排的端口/命令决策纯函数层。
// 两条命令都直接跑目标进程（bun run <file> / bun x <bin> 在单个 bun 进程内
// 执行），保证 scripts/dev.ts 杀子进程时不留孙进程残留。

test('default plan: daemon via cli start on 7777, web via bun x vite', () => {
  const plan = buildSpawnPlan({})
  expect(plan.port).toBe(7777)
  expect(plan.daemon.cmd).toEqual(['bun', 'run', 'src/cli.ts', 'start'])
  expect(plan.web.cmd).toEqual(['bun', 'x', 'vite'])
})

test('MEMSIDE_PORT override is reflected in plan.port', () => {
  expect(buildSpawnPlan({ MEMSIDE_PORT: '8888' }).port).toBe(8888)
})
