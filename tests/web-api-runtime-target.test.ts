// 锁 installRuntimeHooks/uninstallRuntimeHooks 携 target query + 扩展返回类型（spec §3.5）。
// wrapper 是薄 fetch 封装，用源码层文本断言（与既有 web-api 测试同模式）。
// 2026-08-19 spec 四槽：target 扩到 claude|codeagent|opencode|nga，下述正则同步扩四值。
import { test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  getRuntimeSettings, saveRuntimeSettings, getRuntimeStatus, installRuntimeHooks,
} from '@/web/api'

const apiSrc = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'web', 'api.ts'), 'utf-8')

test('installRuntimeHooks 默认 target=claude，带 target 选项', () => {
  // RuntimeTarget 四值类型必须存在（claude|codeagent|opencode|nga）
  expect(apiSrc).toMatch(/type RuntimeTarget = 'claude'\s*\|\s*'codeagent'\s*\|\s*'opencode'\s*\|\s*'nga'/)
  expect(apiSrc).toMatch(/installRuntimeHooks\(\s*target: RuntimeTarget = 'claude'/)
  expect(apiSrc).toContain('install?target=${target}')
  expect(apiSrc).toContain('pluginPath')
})

test('uninstallRuntimeHooks 默认 target=claude，返回含 dirRemoved', () => {
  expect(apiSrc).toMatch(/uninstallRuntimeHooks\(\s*target: RuntimeTarget = 'claude'/)
  expect(apiSrc).toContain('uninstall?target=${target}')
  expect(apiSrc).toContain('dirRemoved')
})

// === 四槽 + status client（spec 2026-08-19）===
test('RuntimeSettingsState 四槽形状', async () => {
  const fake = async (_url: string) => new Response(JSON.stringify({
    claude: { dir: '/a', settingsFilename: 'settings.json' },
    codeagent: { dir: '/b', settingsFilename: 'setting.json' },
    opencode: { dir: '/c' },
    nga: { dir: '/d' },
    defaults: {
      claude: { dir: '', settingsFilename: 'settings.json' },
      codeagent: { dir: '', settingsFilename: 'setting.json' },
      opencode: { dir: '' },
      nga: { dir: '' },
    },
  }), { status: 200 })
  const s = await getRuntimeSettings(fake as any)
  expect(s.claude.dir).toBe('/a')
  expect(s.codeagent.settingsFilename).toBe('setting.json')
})

test('saveRuntimeSettings per-slot patch 透传', async () => {
  const calls: any[] = []
  const fake = async (url: string, init?: any) => {
    calls.push({ url, body: init?.body })
    return new Response(JSON.stringify({
      claude: { dir: '/a', settingsFilename: 'settings.json' },
      codeagent: { dir: '/b', settingsFilename: 'setting.json' },
      opencode: { dir: '/c' },
      nga: { dir: '/d' },
      defaults: {
        claude: { dir: '', settingsFilename: 'settings.json' },
        codeagent: { dir: '', settingsFilename: 'setting.json' },
        opencode: { dir: '' },
        nga: { dir: '' },
      },
    }), { status: 200 })
  }
  await saveRuntimeSettings({ codeagent: { dir: '/b' } }, fake)
  expect(calls[0].url).toBe('/api/settings/runtime')
  expect(JSON.parse(calls[0].body)).toEqual({ codeagent: { dir: '/b' } })
})

test('getRuntimeStatus 调 status 端点', async () => {
  const calls: any[] = []
  const fake = async (url: string) => {
    calls.push(url)
    return new Response(JSON.stringify({
      claude: { installed: true, path: '/a' },
      codeagent: { installed: false, path: '/b' },
      opencode: { installed: true, path: '/c' },
      nga: { installed: false, path: '/d' },
    }), { status: 200 })
  }
  const s = await getRuntimeStatus(fake as any)
  expect(calls[0]).toBe('/api/settings/runtime/status')
  expect(s.claude.installed).toBe(true)
  expect(s.nga.installed).toBe(false)
})

test('installRuntimeHooks 接受四值 target', async () => {
  const calls: any[] = []
  const fake = async (url: string) => {
    calls.push(url)
    return new Response(JSON.stringify({ ok: true }), { status: 200 })
  }
  await installRuntimeHooks('codeagent', fake)
  await installRuntimeHooks('nga', fake)
  expect(calls[0]).toContain('target=codeagent')
  expect(calls[1]).toContain('target=nga')
})
