const PORT = () => process.env.MEMSIDE_PORT || __MEMSIDE_PORT__;
const BASE = () => `http://127.0.0.1:${PORT()}`;
const INJECT_MARK = '--- BEGIN INJECTED MEMORY ---';

// Bun fetch honors HTTP_PROXY/HTTPS_PROXY env (verified against opencode 1.15.5 +
// Bun 1.3.14 on a machine with a system proxy on :7897): without this, the loopback
// fetch to the daemon is routed through the system proxy which returns 502, silently
// breaking capture AND inject. opencode inherits the user's proxy env, so we force
// loopback to bypass it. Append (not overwrite) so a user-set NO_PROXY is preserved.
// 2026-08-04 事故增补：bun 在进程首个 fetch 时固化代理解析，plugin 模块加载期的
// 改写可能晚于 opencode 自身的先行网络活动（TUI 必中）——本守卫只是 belt-and-
// suspenders，正解是 opencode 官方 Network 文档要求的进程启动前环境级
// NO_PROXY=localhost,127.0.0.1。另：被代理劫持时 fetch 照样 resolve（502 不 throw），
// 所有 fetch 响应必须查 res.ok，否则假成功（capture/inject 均已加检查）。
const _noProxy = process.env.NO_PROXY ? process.env.NO_PROXY + ',127.0.0.1,localhost' : '127.0.0.1,localhost';
process.env.NO_PROXY = _noProxy;

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
        const capRes = await fetch(`${BASE()}/hooks/opencode/capture`, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: sessionID, cwd, messages }),
          signal: AbortSignal.timeout(2000),
        });
        // 被代理劫持时 fetch 对 502 照常 resolve 不 throw；不查 res.ok 会把「daemon
        // 根本没收到」记成 capture ok（2026-08-04 TUI 事故）。非 2xx 抛出，走下方
        // catch 记 error 日志。
        if (!capRes.ok) throw new Error(`capture endpoint returned HTTP ${capRes.status}`);
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
        const res = await fetch(`${BASE()}/hooks/opencode/inject?cwd=${encodeURIComponent(cwd)}`, { method: 'GET', signal: AbortSignal.timeout(2000) });
        // 同 capture：代理 502 不 throw，必须查 res.ok（否则 res.json() 解析代理错误页，
        // 错误信息模糊；显式抛带状态码的错误进 catch 日志）。
        if (!res.ok) throw new Error(`inject endpoint returned HTTP ${res.status}`);
        const { block } = await res.json();
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
