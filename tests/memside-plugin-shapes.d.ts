// Ambient 声明：opencode-plugin/memside.js 是 opencode 进程内加载的独立 JS，
// 不在 typecheck include 内也无类型。wildcard ambient module 让测试能 import
// 它（tsconfig 无 allowJs）。不得把 .d.ts 放进 opencode-plugin/——install.ts 的
// cpSync 会把整个目录复制进 opencode 加载路径。
// 重要：只能声明 default export——opencode 1.18.11 plugin 加载器遍历全部 export，
// 非函数 export 直接 throw TypeError("Plugin export is not a function") 中断插件
// 加载，函数 export 还会被逐个当 plugin 调用。此处或源码新增任何 named export
// 都是回归（守卫见 plugin-opencode.test.ts「default-only 导出」文本断言）。
declare module '*/opencode-plugin/memside.js' {
  interface PluginHooks {
    event: (args: { event: { type: string; properties?: Record<string, unknown> } }) => Promise<void>
    'experimental.chat.messages.transform': (
      input: unknown,
      output: { messages: Array<{ info?: { role?: string }; parts: Array<Record<string, unknown>> }> },
    ) => Promise<void>
  }
  const memsidePlugin: (input: { client: unknown; directory: string }) => Promise<PluginHooks>
  export default memsidePlugin
}
