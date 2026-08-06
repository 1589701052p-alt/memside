import { eq } from 'drizzle-orm'
import type { DbClient } from './db/client'
import { appSettings } from './db/schema'

/** UI 配置的 LLM 凭证。token 非空时整级生效（spec：整级短路）。 */
export interface UiLlmConfig {
  baseURL?: string
  token?: string
  model?: string
  /** 双协议支持：缺省（undefined）时由调用方决定回退协议。 */
  protocol?: 'anthropic' | 'openai'
}

const KEYS = { baseURL: 'llm.base_url', token: 'llm.auth_token', model: 'llm.model', protocol: 'llm.protocol' } as const

/** token 打码：前6+…+后4；长度<=10 全码。任何 API 路径不得回明文（spec 硬约束）。 */
export function maskToken(token: string): string {
  if (token.length <= 10) return '•'.repeat(token.length)
  return `${token.slice(0, 6)}…${token.slice(-4)}`
}

/** 读取 UI 级配置；token 缺失（从未设置或被 clear）-> null（UI 级不存在）。 */
export function loadUiLlmConfig(db: DbClient): UiLlmConfig | null {
  const rows = db.select().from(appSettings).all()
  const map = new Map(rows.map((r) => [r.key, r.value]))
  const token = map.get(KEYS.token)
  if (!token) return null
  const out: UiLlmConfig = { token }
  const protocol = map.get(KEYS.protocol)
  if (protocol === 'openai' || protocol === 'anthropic') out.protocol = protocol
  const baseURL = map.get(KEYS.baseURL)
  const model = map.get(KEYS.model)
  if (baseURL) out.baseURL = baseURL
  if (model) out.model = model
  return out
}

/**
 * 字段级合并写（spec）：
 * - clear:true -> 删除整级 key（含 protocol）。
 * - token 提供且非空 -> upsert；缺省/空 -> 保持已存值。
 * - baseURL/model 提供（含 ''）-> 覆盖；'' = 删除该 key（回默认端点/默认模型）。
 */
export function saveUiLlmConfig(
  db: DbClient,
  patch: { baseURL?: string; token?: string; model?: string; protocol?: 'anthropic' | 'openai'; clear?: boolean },
): void {
  if (patch.clear) {
    for (const k of Object.values(KEYS)) db.delete(appSettings).where(eq(appSettings.key, k)).run()
    return
  }
  const upsert = (key: string, value: string) => {
    db.insert(appSettings).values({ key, value, updatedAt: Date.now() })
      .onConflictDoUpdate({ target: appSettings.key, set: { value, updatedAt: Date.now() } })
      .run()
  }
  if (patch.token) upsert(KEYS.token, patch.token)
  if (patch.protocol) upsert(KEYS.protocol, patch.protocol)
  if (patch.baseURL !== undefined) {
    if (patch.baseURL === '') db.delete(appSettings).where(eq(appSettings.key, KEYS.baseURL)).run()
    else upsert(KEYS.baseURL, patch.baseURL)
  }
  if (patch.model !== undefined) {
    if (patch.model === '') db.delete(appSettings).where(eq(appSettings.key, KEYS.model)).run()
    else upsert(KEYS.model, patch.model)
  }
}
