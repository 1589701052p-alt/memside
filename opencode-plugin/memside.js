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
        });
      } catch (e) { /* best-effort: do not throw back to opencode */ }
    },
    'experimental.chat.messages.transform': async (_input, output) => {
      try {
        if (!output.messages?.length) return;
        const firstUser = output.messages.find(m => m.info?.role === 'user');
        if (!firstUser?.parts?.length) return;
        if (firstUser.parts.some(p => p.type === 'text' && p.text?.includes(INJECT_MARK))) return; // idempotency guard
        const res = await fetch(`${BASE()}/hooks/opencode/inject?cwd=${encodeURIComponent(cwd)}`, { method: 'GET' });
        const { block } = await res.json();
        if (!block) return;
        const ref = firstUser.parts[0];
        firstUser.parts.unshift({ ...ref, type: 'text', text: block });
      } catch (e) { /* best-effort */ }
    },
  };
}
