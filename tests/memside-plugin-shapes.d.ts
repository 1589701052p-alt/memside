// Ambient 声明：opencode-plugin/memside.js 是 opencode 进程内加载的独立 JS，
// 不在 typecheck include 内也无类型。wildcard ambient module 让功能测试能 import
// 它（tsconfig 无 allowJs）。不得把 .d.ts 放进 opencode-plugin/——install.ts 的
// cpSync 会把整个目录复制进 opencode 加载路径。
declare module '*/opencode-plugin/memside.js' {
  export const compat: { rememberedShape: 'flat' | 'path' | null };
  export function resetCompatState(): void;
  export function fetchSessionMessages(
    client: unknown,
    sessionID: string,
  ): Promise<{
    res: { data?: unknown } & Record<string, unknown>
    shape: 'flat' | 'path'
    fellBack: boolean
    firstError: unknown
  }>
  export interface PluginHooks {
    event: (args: { event: { type: string; properties?: Record<string, unknown> } }) => Promise<void>
    'experimental.chat.messages.transform': (
      input: unknown,
      output: { messages: Array<{ info?: { role?: string }; parts: Array<Record<string, unknown>> }> },
    ) => Promise<void>
  }
  const memsidePlugin: (input: { client: unknown; directory: string }) => Promise<PluginHooks>
  export default memsidePlugin
}
