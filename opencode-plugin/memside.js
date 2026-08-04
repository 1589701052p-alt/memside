import { request as httpRequestImpl } from 'node:http'

const PORT = () => process.env.MEMSIDE_PORT || __MEMSIDE_PORT__;
const BASE = () => `http://127.0.0.1:${PORT()}`;
const INJECT_MARK = '--- BEGIN INJECTED MEMORY ---';

// loopback 传输层：node:http 从不读取任何代理 env（HTTP_PROXY/HTTPS_PROXY/
// NO_PROXY 全不看），直连 127.0.0.1 是确定性行为。2026-08-04 事故链：bun fetch
// 在 opencode 运行时里代理解析于首个 fetch 固化、NO_PROXY 实证无效，loopback
// POST 被系统代理劫持返 502，TUI capture 静默全灭。详见
// docs/superpowers/specs/2026-08-04-capture-frontier-hardening-design.md §1.3/§4。
// 契约：连接错误 reject；HTTP 非 2xx 照常 resolve（调用方查 status 抛错）。
function httpRequest(url, opts = {}) {
  const { method = 'GET', body, headers, timeoutMs = 2000 } = opts;
  return new Promise((resolve, reject) => {
    const req = httpRequestImpl(url, { method, headers, timeout: timeoutMs }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf-8') }));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error(`request timed out after ${timeoutMs}ms`)));
    if (body) req.write(body);
    req.end();
  });
}

// --- SDK 签名兼容（2026-08-03 事故；spec 2026-08-03-opencode-sdk-compat-design.md）---
// client.session.messages 签名在 opencode 版本间翻转：
//   1.15.x: { path: { id: sessionID } }
//   1.18+:  { sessionID, limit }（扁平；二进制内部调用即此形态）
// 双形态探测，记忆首个成功形态（flat 优先）。成功判据是 res.data 真值而非「没抛错」：
// 生成的 SDK 可能返回错误响应对象而非 throw（二进制内部对 session.get 显式传
// {throwOnError:true} 是反证）。limit:1000 仅 flat 携带（防默认分页截断；distill 侧
// 自有 12000 token 预算裁剪），path 形态保持 1.15.5 已验证原样。
// 注意：compat / shapeName / fetchSessionMessages 刻意保持模块私有，不得加任何具名导出——
// opencode 1.18.11 plugin 加载器遍历模块全部顶层具名符号，非函数直接 throw TypeError
// 中断插件加载，每个函数符号还会被当作 plugin 逐个调用（loader 报错原文见
// tests/plugin-opencode.test.ts「default-only 导出」守卫）。default-only 是唯一跨
// 1.15.x/1.18.x 安全的形态。
const compat = { rememberedShape: null };

function shapeName(shape) {
  return shape.path ? 'path' : 'flat';
}

async function fetchSessionMessages(client, sessionID) {
  const flat = { sessionID, limit: 1000 };
  const path = { path: { id: sessionID } };
  const shapes = compat.rememberedShape === 'path' ? [path, flat] : [flat, path];
  let firstError = null;
  for (let i = 0; i < shapes.length; i += 1) {
    try {
      const res = await client.session.messages(shapes[i]);
      if (res && res.data) {
        compat.rememberedShape = shapeName(shapes[i]);
        return { res, shape: shapeName(shapes[i]), fellBack: i > 0, firstError };
      }
      firstError = firstError ?? new Error(`session.messages returned no data (shape ${shapeName(shapes[i])})`);
    } catch (e) {
      firstError = firstError ?? e;
      await log(client, 'warn', `session.messages ${shapeName(shapes[i])} shape probe failed: ${String(e)}`, { sessionID, shape: shapeName(shapes[i]), error: String(e) });
    }
  }
  throw firstError ?? new Error('session.messages failed on all known shapes');
}

// 日志通道：opencode 官方文档 Logging 章节推荐 client.app.log（写入 opencode 日志文件；
// TUI 模式下 stderr 不可见，纯 console.error 用户看不到）。app.log 自身失败降级
// console.error。永不 throw——plugin 契约是 best-effort（不抛回 opencode）。
async function log(client, level, message, extra) {
  try {
    await client.app.log({ body: { service: 'memside', level, message, extra } });
  } catch (e1) {
    try {
      console.error(`[memside] (${level}) ${message}`, extra ?? '');
    } catch (e2) {
      console.error('[memside] log fallback also failed');
    }
  }
}

export default async function memsidePlugin({ client, directory }) {
  const cwd = directory;
  return {
    event: async ({ event }) => {
      if (event.type !== 'session.idle') return;
      const sessionID = event.properties?.sessionID ?? event.properties?.info?.id;
      if (!sessionID) {
        await log(client, 'error', 'session.idle without sessionID; capture skipped', { properties: event.properties ?? null });
        return;
      }
      try {
        const { res, shape, fellBack, firstError } = await fetchSessionMessages(client, sessionID);
        if (fellBack) {
          await log(client, 'warn', `session.messages flat shape failed, fell back to ${shape}`, { sessionID, firstError: String(firstError) });
        }
        const messages = Array.isArray(res.data) ? res.data : (res.data?.messages ?? []);
        const cap = await httpRequest(`${BASE()}/hooks/opencode/capture`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId: sessionID, cwd, messages }),
        });
        // 非 2xx = daemon 没收到（代理劫持/服务异常）：抛带状态码的错误走下方
        // catch 记 error 日志，绝不记 capture ok（2026-08-04 TUI 事故教训）。
        if (cap.status < 200 || cap.status >= 300) throw new Error(`capture endpoint returned HTTP ${cap.status}`);
        await log(client, 'info', `capture ok session=${sessionID} messages=${messages.length} shape=${shape}`, { sessionID, messages: messages.length, shape });
      } catch (e) {
        await log(client, 'error', `capture failed session=${sessionID}: ${String(e)}`, { sessionID, error: String(e) });
      }
    },
    'experimental.chat.messages.transform': async (_input, output) => {
      try {
        if (!output.messages?.length) return;
        const firstUser = output.messages.find(m => m.info?.role === 'user');
        if (!firstUser?.parts?.length) return;
        if (firstUser.parts.some(p => p.type === 'text' && p.text?.includes(INJECT_MARK))) return; // idempotency guard
        const res = await httpRequest(`${BASE()}/hooks/opencode/inject?cwd=${encodeURIComponent(cwd)}`);
        if (res.status < 200 || res.status >= 300) throw new Error(`inject endpoint returned HTTP ${res.status}`);
        const { block } = JSON.parse(res.body);
        if (!block) return;
        // 仅注入纯 text part：不 spread 原 first part（ref），否则非 text part 的 tool/callID 等
        // 外来字段会泄漏进注入的 text part（final-review Minor #7）。
        firstUser.parts.unshift({ type: 'text', text: block });
      } catch (e) {
        await log(client, 'error', `inject transform failed: ${String(e)}`, { error: String(e) });
      }
    },
  };
}
