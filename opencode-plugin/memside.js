const PORT = () => process.env.MEMSIDE_PORT || __MEMSIDE_PORT__;
const BASE = () => `http://127.0.0.1:${PORT()}`;
const INJECT_MARK = '--- BEGIN INJECTED MEMORY ---';

export default async function memsidePlugin({ client, directory }) {
  const cwd = directory;
  return {
    event: async ({ event }) => {
      if (event.type !== 'session.idle') return;
      try {
        const sessionID = event.properties?.sessionID ?? event.properties?.info?.id;
        if (!sessionID) return;
        const res = await client.session.messages({ sessionID });
        const messages = (res.data?.messages ?? res.data ?? []);
        await fetch(`${BASE()}/hooks/opencode/capture`, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: sessionID, cwd, messages }),
          signal: AbortSignal.timeout(2000),
        });
      } catch (e) { /* best-effort: do not throw back to opencode */ }
    },
    'experimental.chat.messages.transform': async (_input, output) => {
      try {
        if (!output.messages?.length) return;
        const firstUser = output.messages.find(m => m.info?.role === 'user');
        if (!firstUser?.parts?.length) return;
        if (firstUser.parts.some(p => p.type === 'text' && p.text?.includes(INJECT_MARK))) return; // idempotency guard
        const res = await fetch(`${BASE()}/hooks/opencode/inject?cwd=${encodeURIComponent(cwd)}`, { method: 'GET', signal: AbortSignal.timeout(2000) });
        const { block } = await res.json();
        if (!block) return;
        // 仅注入纯 text part：不 spread 原 first part（ref），否则非 text part 的 tool/callID 等
        // 外来字段会泄漏进注入的 text part（final-review Minor #7）。
        firstUser.parts.unshift({ type: 'text', text: block });
      } catch (e) { /* best-effort */ }
    },
  };
}
