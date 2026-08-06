import { connect } from 'node:net'

const PORT = () => process.env.MEMSIDE_PORT || __MEMSIDE_PORT__;
const BASE = () => `http://127.0.0.1:${PORT()}`;
const INJECT_MARK = '--- BEGIN INJECTED MEMORY ---';

// loopback 代理豁免（保留为无害冗余）：此追加对 SDK 的 bun fetch 偶发生效
// （client.app.log 等 SDK 调用走 bun fetch，bun fetch 偶发尊重 NO_PROXY）；loopback
// 直连的确定性由下方 node:net 裸 socket 保证（结构上不读任何代理 env）。追加非
// 覆盖，保留用户出站代理。历史：PR #38 时代曾误删此追加致 502 回归（2026-08-04
// live 复现），勿再删除。
{
  const cur = (process.env.NO_PROXY ?? '').split(',').map(s => s.trim()).filter(Boolean);
  for (const h of ['127.0.0.1', 'localhost']) if (!cur.includes(h)) cur.push(h);
  process.env.NO_PROXY = cur.join(',');
}

// loopback 传输层：node:net 裸 socket 手写 HTTP/1.1。
// 为什么不用 node 的 http 模块（2026-08-05 挂死事故，spec §1.2d/§4.2）：bun 的
// http 模块 polyfill 读 HTTP_PROXY 劫持 loopback、createConnection 被静默忽略、
// timeout 后 destroy 不结算 Promise。node:net 裸 socket 结构上不读任何代理 env
// （live 实证 spec §1.2e），直连是构造事实而非行为运气。结算安全由钩子入口
// settleWithin 兜底，socket setTimeout 只作尽早回收。
// 契约：连接/解析错误 reject；HTTP 非 2xx 照常 resolve（调用方查 status 抛错）。
function httpRequest(url, opts = {}) {
  const { method = 'GET', body, headers, timeoutMs = 2000 } = opts;
  const u = new URL(url);
  const port = Number(u.port || 80);
  const path = u.pathname + u.search;
  return new Promise((resolve, reject) => {
    let done = false;
    const chunks = [];
    const sock = connect(port, u.hostname);
    const fail = (e) => { if (!done) { done = true; sock.destroy(); reject(e); } };
    sock.setTimeout(timeoutMs, () => fail(new Error(`socket timeout after ${timeoutMs}ms`)));
    sock.on('error', fail);
    sock.on('connect', () => {
      const head = [`${method} ${path} HTTP/1.1`, `Host: ${u.hostname}:${port}`, 'Connection: close'];
      for (const [k, v] of Object.entries(headers ?? {})) head.push(`${k}: ${v}`);
      if (body) head.push(`Content-Length: ${Buffer.byteLength(body)}`);
      sock.write(head.join('\r\n') + '\r\n\r\n' + (body ?? ''));
    });
    sock.on('data', (c) => chunks.push(c));
    sock.on('end', () => {
      if (done) return;
      done = true;
      // 解析错误经 promise 链转 reject（刻意不用 try/catch：'catch 必记日志' 回归守卫
      // 要求每个 catch 块自带日志调用，而传输层没有 client；reject 上抛由调用方记日志）。
      Promise.resolve()
        .then(() => parseHttpResponse(Buffer.concat(chunks)))
        .then(resolve, reject);
    });
  });
}

function parseHttpResponse(buf) {
  const sep = buf.indexOf('\r\n\r\n');
  if (sep < 0) throw new Error('malformed HTTP response: no header terminator');
  const headLines = buf.slice(0, sep).toString('ascii').split('\r\n');
  const status = Number(headLines[0].split(' ')[1]);
  if (!status) throw new Error(`malformed HTTP status line: ${headLines[0]}`);
  const headers = {};
  for (const line of headLines.slice(1)) {
    const i = line.indexOf(':');
    if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  let bodyBuf = buf.slice(sep + 4);
  if (headers['transfer-encoding'] === 'chunked') bodyBuf = dechunk(bodyBuf);
  else if (headers['content-length'] != null && bodyBuf.length < Number(headers['content-length'])) {
    throw new Error('truncated response body');
  }
  return { status, body: bodyBuf.toString('utf-8') };
}

function dechunk(buf) {
  const out = [];
  let i = 0;
  while (i < buf.length) {
    const lineEnd = buf.indexOf('\r\n', i);
    if (lineEnd < 0) throw new Error('malformed chunked encoding');
    const size = parseInt(buf.slice(i, lineEnd).toString('ascii').split(';')[0], 16);
    if (Number.isNaN(size)) throw new Error('malformed chunk size');
    if (size === 0) break;
    const start = lineEnd + 2;
    if (start + size > buf.length) throw new Error('truncated chunk');
    out.push(buf.slice(start, start + size));
    i = start + size + 2;
  }
  return Buffer.concat(out);
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
      void log(client, 'warn', `session.messages ${shapeName(shapes[i])} shape probe failed: ${String(e)}`, { sessionID, shape: shapeName(shapes[i]), error: String(e) });
    }
  }
  throw firstError ?? new Error('session.messages failed on all known shapes');
}

// 日志通道：opencode 官方文档 Logging 章节推荐 client.app.log（写入 opencode 日志文件；
// TUI 模式下 stderr 不可见，纯 console.error 用户看不到）。app.log 自身失败降级
// console.error。永不 throw——plugin 契约是 best-effort（不抛回 opencode）。
// 所有调用点均 fire-and-forget（void）——调用方不得 await 本函数（app.log 走 bun
// fetch 可能不结算，见 settleWithin 注释）。
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

// --- 结算不变量（2026-08-05 挂死事故根治，spec 2026-08-05-opencode-plugin-hang-settlement-design.md §5）---
// opencode 的 Plugin.trigger 对 transform 钩子串行 await（1.18.13 二进制取证）：
// 钩子 Promise 不结算 = 消息管线永久冻住。而 bun（opencode 内嵌运行时）的
// http 模块 polyfill 在 timeout 后 destroy 不结算 Promise（对照实验证实）——一切依赖
// 运行时行为的超时守卫都不可靠。settleWithin 只用纯 JS 语义（Promise.race +
// 定时器），是钩子唯一的安全依赖：预算内必然结算，超时按失败走 catch 通道。
const TRANSFORM_BUDGET_MS = 2000;  // 消息管线同步路径：用户拍板的最坏感知延迟
const EVENT_BUDGET_MS = 30000;     // fire-and-forget 卫生预算：覆盖大会话拉 1000 条消息的合法慢

function settleWithin(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} did not settle within ${ms}ms`)), ms);
    promise.then((v) => { clearTimeout(timer); resolve(v); }, (e) => { clearTimeout(timer); reject(e); });
  });
}

async function handleSessionIdle(client, event, cwd) {
  if (event.type !== 'session.idle') return;
  const sessionID = event.properties?.sessionID ?? event.properties?.info?.id;
  if (!sessionID) {
    void log(client, 'error', 'session.idle without sessionID; capture skipped', { properties: event.properties ?? null });
    return;
  }
  try {
    const { res, shape, fellBack, firstError } = await fetchSessionMessages(client, sessionID);
    if (fellBack) {
      void log(client, 'warn', `session.messages flat shape failed, fell back to ${shape}`, { sessionID, firstError: String(firstError) });
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
    void log(client, 'info', `capture ok session=${sessionID} messages=${messages.length} shape=${shape}`, { sessionID, messages: messages.length, shape });
  } catch (e) {
    void log(client, 'error', `capture failed session=${sessionID}: ${String(e)}`, { sessionID, error: String(e) });
  }
}

async function handleTransform(client, output, cwd) {
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
    void log(client, 'error', `inject transform failed: ${String(e)}`, { error: String(e) });
  }
}

export default async function memsidePlugin({ client, directory }) {
  const cwd = directory;
  return {
    event: async ({ event }) => {
      try {
        await settleWithin(handleSessionIdle(client, event, cwd), EVENT_BUDGET_MS, 'session.idle handler');
      } catch (e) {
        // 结算超时/内部逃逸错误：fire-and-forget 记日志——此处绝不能再 await
        // （client.app.log 走 bun fetch，同样可能不结算；前门堵挂死后门不能再开）。
        void log(client, 'error', `event handler failed: ${String(e)}`, { error: String(e) });
      }
    },
    'experimental.chat.messages.transform': async (_input, output) => {
      try {
        await settleWithin(handleTransform(client, output, cwd), TRANSFORM_BUDGET_MS, 'messages.transform handler');
      } catch (e) {
        void log(client, 'error', `transform handler failed: ${String(e)}`, { error: String(e) });
      }
    },
  };
}
