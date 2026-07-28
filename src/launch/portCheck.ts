/**
 * 端口占用防呆（2026-07-28-port-reclaim-guard）：启动前检测目标端口被占时，
 * 列出占用进程 PID + 命令行，询问用户是否杀掉后继续，而非裸抛 EADDRINUSE。
 *
 * 平台 / TTY / spawn 依赖全部参数化注入，便于纯函数单测；生产 ctx 在
 * scripts/start.ts、scripts/dev.ts 顶层组装。
 *
 * 三步：findPortHolders（查）-> promptReclaim（问，Task 2）-> reclaim（杀，Task 3）。
 * daemon/cli 零改动，EADDRINUSE 仍是兜底。
 */

export interface PortHolder {
  port: number
  pid: number
  cmdline: string
}

export interface PortCheckCtx {
  platform: NodeJS.Platform
  spawn: (cmd: string[]) => Promise<{ stdout: string; exitCode: number | null }>
}

/**
 * 查询哪些端口被哪个 PID 占用。Windows: netstat -ano + wmic；posix: lsof + ps。
 * 命令失败/不存在 -> 降级空数组（不阻塞启动，让 EADDRINUSE 兜底）。
 * 同端口多 PID 全列；命令行取不到留空字符串。
 */
export async function findPortHolders(ports: number[], ctx: PortCheckCtx): Promise<PortHolder[]> {
  if (ports.length === 0) return []
  try {
    return ctx.platform === 'win32' ? await findByNetstat(ports, ctx) : await findByLsof(ports, ctx)
  } catch {
    return []
  }
}

async function findByNetstat(ports: number[], ctx: PortCheckCtx): Promise<PortHolder[]> {
  const out = await ctx.spawn(['netstat', '-ano'])
  // 匹配所有 LISTENING 行，按端口过滤。形如：
  //   TCP    127.0.0.1:7777   0.0.0.0:0   LISTENING   18196
  const re = /\s+TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)/g
  const pidByPort = new Map<number, number[]>()
  let m: RegExpExecArray | null
  while ((m = re.exec(out.stdout)) !== null) {
    const port = Number(m[1])
    const pid = Number(m[2])
    if (!ports.includes(port) || !Number.isFinite(pid)) continue
    const arr = pidByPort.get(port) ?? []
    if (!arr.includes(pid)) arr.push(pid)
    pidByPort.set(port, arr)
  }
  const holders: PortHolder[] = []
  for (const [port, pids] of pidByPort) {
    for (const pid of pids) {
      holders.push({ port, pid, cmdline: await getCmdlineWin(pid, ctx) })
    }
  }
  return holders
}

async function getCmdlineWin(pid: number, ctx: PortCheckCtx): Promise<string> {
  try {
    const out = await ctx.spawn(['wmic', 'process', 'where', `ProcessId=${pid}`, 'get', 'CommandLine', '/value'])
    const m = out.stdout.match(/CommandLine=(.*)/)
    return m ? m[1].trim() : ''
  } catch {
    return ''
  }
}

async function findByLsof(ports: number[], ctx: PortCheckCtx): Promise<PortHolder[]> {
  const holders: PortHolder[] = []
  for (const port of ports) {
    let pids: number[] = []
    try {
      const out = await ctx.spawn(['lsof', `-ti:${port}`])
      pids = out.stdout.split('\n').map((l) => Number(l.trim())).filter((n) => Number.isFinite(n) && n > 0)
    } catch {
      continue // lsof 非零退出 = 端口未占
    }
    for (const pid of pids) {
      holders.push({ port, pid, cmdline: await getCmdlinePosix(pid, ctx) })
    }
  }
  return holders
}

async function getCmdlinePosix(pid: number, ctx: PortCheckCtx): Promise<string> {
  try {
    const out = await ctx.spawn(['ps', '-p', String(pid), '-o', 'command='])
    return out.stdout.trim()
  } catch {
    return ''
  }
}

export interface ReclaimCtx {
  isTTY: boolean
  readline: () => Promise<string>
}

/**
 * 列出占用进程并询问是否杀掉。holders 为空 -> true（继续启动）；非 TTY ->
 * 打印列表 + 提示后返回 false；TTY -> 打印列表 + (y/N) 询问，y/yes 返回 true。
 */
export async function promptReclaim(holders: PortHolder[], ctx: ReclaimCtx): Promise<boolean> {
  if (holders.length === 0) return true
  console.log('memside: 以下端口已被占用：')
  for (const h of holders) {
    console.log(`  [port ${h.port}] PID ${h.pid}: ${h.cmdline || '(命令行未知)'}`)
  }
  if (!ctx.isTTY) {
    console.log('memside: 非交互环境，请手动回收以上进程后重试。')
    return false
  }
  const ans = (await ctx.readline()).trim().toLowerCase()
  return ans === 'y' || ans === 'yes'
}

/**
 * 杀掉 holders 里的占用进程。只杀占端口的那一个 PID（不递归父/子），同 PID
 * 去重只杀一次。杀失败（进程已退出/权限不足）打印 warn，不抛、不中止。
 * Windows: taskkill //PID <pid> //F；posix: process.kill(pid, 'SIGKILL')。
 */
export async function reclaim(holders: PortHolder[], ctx: PortCheckCtx): Promise<void> {
  const seen = new Set<number>()
  for (const h of holders) {
    if (seen.has(h.pid)) continue
    seen.add(h.pid)
    try {
      if (ctx.platform === 'win32') {
        await ctx.spawn(['taskkill', '//PID', String(h.pid), '//F'])
      } else {
        process.kill(h.pid, 'SIGKILL')
      }
    } catch (e) {
      console.warn(`memside: 杀进程 PID ${h.pid} 失败（可能已退出）：${(e as Error).message}`)
    }
  }
}
