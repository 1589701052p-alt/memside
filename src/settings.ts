import { eq } from 'drizzle-orm'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { DbClient } from './db/client'
import { appSettings } from './db/schema'
import type { JudgeConfig } from '@/memory/judgeConfig'
import { DEFAULT_JUDGE_CONFIG } from '@/memory/judgeConfig'

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

// --- 判定配置（judge mode + agent 预算）--------------------------------------

const JUDGE_KEYS = { mode: 'judge.mode', maxRounds: 'judge.max_rounds', timeBudgetS: 'judge.time_budget_s' } as const
const MAX_ROUNDS_RANGE = [1, 200] as const
const TIME_BUDGET_RANGE = [30, 3600] as const

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n))

/** 判定配置读取:缺失/非法逐字段回默认;数字夹取到合法区间。 */
export function loadJudgeConfig(db: DbClient): JudgeConfig {
  const rows = db.select().from(appSettings).all()
  const map = new Map(rows.map((r) => [r.key, r.value]))
  const mode = map.get(JUDGE_KEYS.mode)
  const rounds = Number(map.get(JUDGE_KEYS.maxRounds))
  const budget = Number(map.get(JUDGE_KEYS.timeBudgetS))
  return {
    mode: mode === 'quality' || mode === 'economy' ? mode : DEFAULT_JUDGE_CONFIG.mode,
    maxRounds: Number.isFinite(rounds) && map.has(JUDGE_KEYS.maxRounds)
      ? clamp(Math.round(rounds), MAX_ROUNDS_RANGE[0], MAX_ROUNDS_RANGE[1]) : DEFAULT_JUDGE_CONFIG.maxRounds,
    timeBudgetS: Number.isFinite(budget) && map.has(JUDGE_KEYS.timeBudgetS)
      ? clamp(Math.round(budget), TIME_BUDGET_RANGE[0], TIME_BUDGET_RANGE[1]) : DEFAULT_JUDGE_CONFIG.timeBudgetS,
  }
}

/** 判定配置字段级保存(提供的字段才写,同 saveUiLlmConfig 的字段级语义)。 */
export function saveJudgeConfig(db: DbClient, patch: Partial<JudgeConfig>): void {
  const upsert = (key: string, value: string) => {
    db.insert(appSettings).values({ key, value, updatedAt: Date.now() })
      .onConflictDoUpdate({ target: appSettings.key, set: { value, updatedAt: Date.now() } }).run()
  }
  if (patch.mode !== undefined) upsert(JUDGE_KEYS.mode, patch.mode)
  if (patch.maxRounds !== undefined) upsert(JUDGE_KEYS.maxRounds, String(patch.maxRounds))
  if (patch.timeBudgetS !== undefined) upsert(JUDGE_KEYS.timeBudgetS, String(patch.timeBudgetS))
}

// --- 运行环境路径配置（spec 2026-08-17-runtime-path-config）-----------------
// codeagent 读 ~/.cac/setting.json（目录与文件名双双不同于标准 ~/.claude/settings.json）。
// 用户在 UI 配置路径，install 据此装到正确文件。三字段落 app_settings，缺失回默认。

/** portably resolve home (mirrors resolveHome in creds.ts / install.ts). */
function resolveHome(): string {
  return process.env.HOME || process.env.USERPROFILE || homedir()
}

/**
 * Expand a leading `~` to the resolved home directory (IF-1 fix). Without this,
 * a `~`-prefixed claudeDir saved from the UI (`~/.cac`) is passed verbatim to
 * `installHooks` → `mkdirSync('~/.cac')` creates a literal `~` directory and
 * hooks land in `./~/.cac/setting.json`, which codeagent never reads — silently
 * breaking the capture→inject loop on daemon restart / `memside install`.
 * Absolute paths and the defaults (already absolute) pass through unchanged.
 */
function expandTilde(p: string): string {
  if (p.startsWith('~')) return join(resolveHome(), p.slice(1))
  return p
}

// --- 运行环境路径配置（spec 2026-08-19-runtime-settings-four-slots）-----------------
// 四槽独立配置：claude / codeagent / opencode / nga。hooks 型（claude、codeagent）各
// 持 dir + settingsFilename；plugin 型（opencode、nga）仅 dir。旧 3 共享 key
// （runtime.claude_dir / runtime.settings_filename / runtime.opencode_dir）按迁移启发式
// 归位到新槽（READ-ONLY，不删旧 key），零数据丢失。

export interface RuntimePaths {
  /** claude 配置目录 + settings 文件名（默认 ~/.claude/settings.json）。 */
  claude: { dir: string; settingsFilename: string }
  /** codeagent 配置目录 + settings 文件名（默认 ~/.cac/setting.json，双双不同）。 */
  codeagent: { dir: string; settingsFilename: string }
  /** opencode 配置目录（默认 ~/.config/opencode）。 */
  opencode: { dir: string }
  /** nga 配置目录（默认 ~/.config/opencode，本次存而不用）。 */
  nga: { dir: string }
}

const RUNTIME_KEYS = {
  claudeDir: 'runtime.claude.dir',
  claudeSettingsFilename: 'runtime.claude.settings_filename',
  codeagentDir: 'runtime.codeagent.dir',
  codeagentSettingsFilename: 'runtime.codeagent.settings_filename',
  opencodeDir: 'runtime.opencode.dir',
  ngaDir: 'runtime.nga.dir',
} as const

// 旧共享 key（迁移探测用，永不写入）：旧 settings_filename 是单数无 slot 前缀。
const LEGACY_KEYS = {
  claudeDir: 'runtime.claude_dir',
  settingsFilename: 'runtime.settings_filename',
  opencodeDir: 'runtime.opencode_dir',
} as const

/** 四槽默认值（与 install.ts/creds.ts 既有默认路径一致，零回归基准）。 */
export function defaultRuntimePaths(): RuntimePaths {
  const home = resolveHome()
  return {
    claude: { dir: join(home, '.claude'), settingsFilename: 'settings.json' },
    codeagent: { dir: join(home, '.cac'), settingsFilename: 'setting.json' },
    opencode: { dir: join(home, '.config', 'opencode') },
    nga: { dir: join(home, '.config', 'opencode') },
  }
}

/**
 * per-slot 字段级 patch：提供才写；`dir`/`settingsFilename` 均可选。
 * 空串 = 删该 key（回默认）。非字符串值不会进 patch（TS 类型守卫 + server 层校验）。
 */
export type RuntimePathsPatch = {
  claude?: { dir?: string; settingsFilename?: string }
  codeagent?: { dir?: string; settingsFilename?: string }
  opencode?: { dir?: string }
  nga?: { dir?: string }
}

/** 取非空值并展开 `~`；空/缺 -> fallback。 */
function pickExpanded(value: string | undefined, fallback: string): string {
  if (value && value.length > 0) return expandTilde(value)
  return fallback
}

/**
 * 读取：新 key 优先；新 key 缺失时旧共享 key 按迁移启发式归位（spec §3.2）：
 * - 旧 claude_dir + settings_filename 共享一对：settingsFilename === 'setting.json'
 *   或 claudeDir 以 .cac 结尾 -> 归 codeagent 槽；否则归 claude 槽。另一槽取默认。
 * - 旧 opencode_dir -> opencode 槽；nga 无旧 key，取默认。
 * 迁移 READ-ONLY（不删旧 key）。脏数据不抛（缺失/空/非法 -> 默认）。返回前 `~` 已展开（IF-1）。
 */
export function loadRuntimePaths(db: DbClient): RuntimePaths {
  const rows = db.select().from(appSettings).all()
  const map = new Map(rows.map((r) => [r.key, r.value]))
  const d = defaultRuntimePaths()
  const legClaudeDir = map.get(LEGACY_KEYS.claudeDir)
  const legSettingsFilename = map.get(LEGACY_KEYS.settingsFilename)
  const legOpencodeDir = map.get(LEGACY_KEYS.opencodeDir)
  // 迁移启发式：旧共享 pair 归 codeagent 还是 claude（仅当新 key 缺失时才用作 fallback）。
  const legIsCodeagent = !!(
    legClaudeDir
    && (legSettingsFilename === 'setting.json' || legClaudeDir.replace(/\\/g, '/').endsWith('.cac'))
  )
  return {
    claude: {
      dir: pickExpanded(
        map.get(RUNTIME_KEYS.claudeDir),
        legIsCodeagent ? d.claude.dir : pickExpanded(legClaudeDir, d.claude.dir),
      ),
      settingsFilename: pickExpanded(
        map.get(RUNTIME_KEYS.claudeSettingsFilename),
        legIsCodeagent ? d.claude.settingsFilename : pickExpanded(legSettingsFilename, d.claude.settingsFilename),
      ),
    },
    codeagent: {
      dir: pickExpanded(
        map.get(RUNTIME_KEYS.codeagentDir),
        legIsCodeagent ? pickExpanded(legClaudeDir, d.codeagent.dir) : d.codeagent.dir,
      ),
      settingsFilename: pickExpanded(
        map.get(RUNTIME_KEYS.codeagentSettingsFilename),
        legIsCodeagent ? pickExpanded(legSettingsFilename, d.codeagent.settingsFilename) : d.codeagent.settingsFilename,
      ),
    },
    opencode: { dir: pickExpanded(map.get(RUNTIME_KEYS.opencodeDir), pickExpanded(legOpencodeDir, d.opencode.dir)) },
    nga: { dir: pickExpanded(map.get(RUNTIME_KEYS.ngaDir), d.nga.dir) },
  }
}

/** per-slot 字段级合并写：提供才写；空串 = 删该 key（回默认）。 */
export function saveRuntimePaths(db: DbClient, patch: RuntimePathsPatch): void {
  const upsert = (key: string, value: string) => {
    db.insert(appSettings).values({ key, value, updatedAt: Date.now() })
      .onConflictDoUpdate({ target: appSettings.key, set: { value, updatedAt: Date.now() } }).run()
  }
  const del = (key: string) => db.delete(appSettings).where(eq(appSettings.key, key)).run()
  const w = (key: string, v: string | undefined) => {
    if (v === undefined) return
    if (v === '') del(key)
    else upsert(key, v)
  }
  if (patch.claude) {
    w(RUNTIME_KEYS.claudeDir, patch.claude.dir)
    w(RUNTIME_KEYS.claudeSettingsFilename, patch.claude.settingsFilename)
  }
  if (patch.codeagent) {
    w(RUNTIME_KEYS.codeagentDir, patch.codeagent.dir)
    w(RUNTIME_KEYS.codeagentSettingsFilename, patch.codeagent.settingsFilename)
  }
  if (patch.opencode) { w(RUNTIME_KEYS.opencodeDir, patch.opencode.dir) }
  if (patch.nga) { w(RUNTIME_KEYS.ngaDir, patch.nga.dir) }
}
