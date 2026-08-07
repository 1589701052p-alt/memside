// src/memory/repoTools.ts
import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import path from 'node:path'

export const GREP_MAX_HITS = 20
export const GREP_HIT_CONTEXT_CHARS = 200
export const GREP_TOTAL_CAP = 4000
export const READ_MAX_LINES = 200
export const LIST_MAX_ENTRIES = 200
const SKIP_DIRS = new Set(['.git', 'node_modules'])
const GREP_FILE_SIZE_CAP = 1_000_000

export interface RepoTools {
  /** 执行只读工具,返回喂给模型的纯文本;永不抛(错误即文本)。 */
  execute(tool: string, args: Record<string, unknown>): Promise<string>
}

/**
 * agent 判定器的三只手(spec §4.3):grep/read/list,全部只读,沙箱锁死 rootDir。
 * 路径解析(含符号链接)后必须仍以 root 为前缀,越界返回「拒绝」文本——
 * 错误永远以文本形式回到对话,不抛异常炸 agent 循环。
 */
export function makeRepoTools(rootDir: string): RepoTools {
  const root = realpathSync(rootDir)
  const insideRoot = (real: string) => real === root || real.startsWith(root + path.sep)
  const resolveInside = (p: string): string | null => {
    try {
      const abs = path.resolve(root, p)
      if (abs !== root && !abs.startsWith(root + path.sep)) return null
      try {
        const real = realpathSync(abs)
        return insideRoot(real) ? real : null
      } catch {
        // 文件尚不存在:只要解析后路径仍在 root 内就允许,交给后续操作返回「不存在」。
        return abs
      }
    } catch { return null }
  }

  const walk = (dir: string, out: string[] = []): string[] => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(path.join(dir, e.name), out)
      } else out.push(path.join(dir, e.name))
      if (out.length > 20_000) break  // 超大仓库防爆
    }
    return out
  }

  const grep = (pattern: string, sub?: string): string => {
    const base = sub ? resolveInside(sub) : root
    if (!base || !insideRoot(base)) return `拒绝:路径越出项目目录`
    const files = statSync(base).isDirectory() ? walk(base) : [base]
    const hits: string[] = []
    let total = 0
    for (const f of files) {
      if (hits.length >= GREP_MAX_HITS || total >= GREP_TOTAL_CAP) break
      try {
        if (statSync(f).size > GREP_FILE_SIZE_CAP) continue
        const text = readFileSync(f, 'utf8')
        const lines = text.split('\n')
        for (let i = 0; i < lines.length && hits.length < GREP_MAX_HITS && total < GREP_TOTAL_CAP; i++) {
          if (!lines[i]!.includes(pattern)) continue
          const snippet = lines[i]!.slice(0, GREP_HIT_CONTEXT_CHARS)
          const rel = path.relative(root, f)
          const entry = `${rel}:${i + 1}: ${snippet}`
          hits.push(entry)
          total += entry.length
        }
      } catch { continue }  // 二进制/编码问题跳过
    }
    if (hits.length === 0) return `0 处命中`
    const more = hits.length >= GREP_MAX_HITS ? `\n(已达 ${GREP_MAX_HITS} 处封顶,可能还有更多)` : ''
    return hits.join('\n') + more
  }

  const read = (p: string, startLine?: number, endLine?: number): string => {
    const real = resolveInside(p)
    if (!real || !insideRoot(real)) return `拒绝:路径越出项目目录`
    try {
      if (!statSync(real).isFile()) return `不存在:不是文件 ${p}`
      const lines = readFileSync(real, 'utf8').split('\n')
      const s = Math.max(1, startLine ?? 1)
      const e = Math.min(lines.length, endLine ?? s + READ_MAX_LINES - 1, s + READ_MAX_LINES - 1)
      const body = lines.slice(s - 1, e).join('\n')
      const tail = e < lines.length ? `\n(共 ${lines.length} 行,已显示 ${s}-${e})` : ''
      return body + tail
    } catch { return `不存在:${p}` }
  }

  const list = (p?: string): string => {
    const real = p ? resolveInside(p) : root
    if (!real || !insideRoot(real)) return `拒绝:路径越出项目目录`
    try {
      const entries = readdirSync(real).slice(0, LIST_MAX_ENTRIES)
      return entries.join('\n')
    } catch { return `不存在:${p ?? '.'}` }
  }

  return {
    async execute(tool, args) {
      try {
        switch (tool) {
          case 'grep': return grep(String(args.pattern ?? ''), args.path === undefined ? undefined : String(args.path))
          case 'read': return read(String(args.path ?? ''),
            typeof args.startLine === 'number' ? args.startLine : undefined,
            typeof args.endLine === 'number' ? args.endLine : undefined)
          case 'list': return list(args.path === undefined ? undefined : String(args.path))
          default: return `未知工具:${tool}(可用:grep/read/list)`
        }
      } catch (e) {
        return `工具执行失败:${e instanceof Error ? e.message : String(e)}`
      }
    },
  }
}
