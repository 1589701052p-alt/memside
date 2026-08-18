import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// 安装器 finish 页引导：装完可勾选「立即启动 memside」启动 exe → 开浏览器。
const nsi = readFileSync(join(import.meta.dir, '..', 'installer', 'installer.nsi'), 'utf8')

describe('installer.nsi finish 页引导', () => {
  test('设 MUI_FINISHPAGE_RUN 指向 exe', () => {
    expect(nsi).toContain('MUI_FINISHPAGE_RUN')
    expect(nsi).toContain('$INSTDIR\\memside.exe')
  })

  test('finish 页文案中文化', () => {
    expect(nsi).toContain('MUI_FINISHPAGE_RUN_TEXT')
    expect(nsi).toMatch(/立即启动/)
  })

  test('MUI_PAGE_FINISH 仍存在', () => {
    expect(nsi).toContain('MUI_PAGE_FINISH')
  })
})
