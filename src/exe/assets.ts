/**
 * Spec B 接缝 4：exe 资产装配。
 *
 * 把 src/web/dist/ + opencode-plugin/ 内嵌进单文件 exe（bun build --compile），
 * 暴露为 createApp.staticAssets + installOpencodePlugin.files 所需统一形状。
 *
 * 实测 Bun 1.3.14 的 `with { type: 'directory' }` directory import 在
 * `bun build --compile` 下报 "Could not resolve"（详见 task-4-report.md），
 * `with { type: 'file' }` 落回 text（非 BunFile 句柄），均无法拿 Uint8Array。
 * 故采用 Ruling-C 回退路径：构建期 `scripts/gen-manifest.ts` 枚举 dist + 插件
 * 文件写成 `src/exe/manifest.ts`（base64/文本常量），本模块 import 它并在运行时
 * 装配成 {indexHtml, assets, pluginJs, pluginPkg}。
 *
 * manifest.ts 是普通 TS 模块（无 `with` 资产导入语法），故本模块既可被
 * `bun build --compile` 消费，也可被 `bun test` / dev 直接 import。
 */
import { INDEX_HTML, ASSET_FILES, PLUGIN_JS, PLUGIN_PKG } from './manifest'

export interface EmbeddedAssets {
  indexHtml: string
  /** key 形如 'assets/index-abc.js'（与 createApp 里 c.req.path.replace(/^\//,'') 一致）。 */
  assets: Record<string, Uint8Array>
  /** opencode-plugin/memside.js 内容（含 __MEMSIDE_PORT__ 占位，安装时烘焙）。 */
  pluginJs: string
  /** opencode-plugin/package.json 内容（JSON 文本字符串，installOpencodePlugin 写盘）。 */
  pluginPkg: string
}

/** gen-manifest 烘焙的 manifest.ts 四常量形状。抽出供测试注入，生产从 import 来。 */
export interface Manifest {
  INDEX_HTML: string
  ASSET_FILES: [string, string][]   // [key, base64]
  PLUGIN_JS: string
  PLUGIN_PKG: string
}

/**
 * 把 manifest 装配成 createApp.staticAssets + installOpencodePlugin.files
 * 所需的统一对象。纯函数（相对 Bun 运行时）：相同 manifest 产出相同 map；不读外部磁盘、
 * 不依赖 import。assets 用 base64 解码（二进制安全，覆盖未来 png/font/svg 等）。
 * index.html / pluginJs / pluginPkg 是已知文本，直接透传字符串。
 */
export function assembleAssets(m: Manifest): EmbeddedAssets {
  const assets: Record<string, Uint8Array> = {}
  for (const [key, b64] of m.ASSET_FILES) {
    // Buffer.from(b64,'base64') 返回 Buffer（Uint8Array 子类），二进制安全。
    assets[key] = Buffer.from(b64, 'base64')
  }
  return {
    indexHtml: m.INDEX_HTML,
    assets,
    pluginJs: m.PLUGIN_JS,
    pluginPkg: m.PLUGIN_PKG,
  }
}

/**
 * 把内嵌 manifest 装配成 createApp.staticAssets + installOpencodePlugin.files
 * 所需的统一对象。委托 {@link assembleAssets}——装配逻辑（base64 解码 + 字段映射）都在
 * 那个同步纯函数里，此处仅负责从 import 的 manifest 常量构造 Manifest 对象传入，
 * 以便测试可对 assembleAssets 注入自造 manifest 而不依赖磁盘 dist / git manifest。
 *
 * 保持 async 签名（launcher `await` 它不变）；返回值与旧内联实现逐字节一致
 * （同一装配逻辑搬进 assembleAssets，只是包了一层）。
 */
export async function loadEmbeddedAssets(): Promise<EmbeddedAssets> {
  return assembleAssets({ INDEX_HTML, ASSET_FILES, PLUGIN_JS, PLUGIN_PKG })
}
