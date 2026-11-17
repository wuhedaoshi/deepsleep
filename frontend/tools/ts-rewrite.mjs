/**
 * 让 Node 直接跑 `src/services/**` 下的 TypeScript：把 `./x.js` 这类源码内约定的
 * ESM 后缀改指到同名 `.ts`（仓库里没有编译产物，`.js` 只是写法约定）。
 * 只在 tools/ 的脚本里用，不参与打包。
 */
import { existsSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'

export async function resolve(specifier, context, next) {
  if (specifier.endsWith('.js') && (specifier.startsWith('./') || specifier.startsWith('../'))) {
    const target = context.parentURL ? new URL(specifier, context.parentURL) : null
    if (target !== null && target.protocol === 'file:') {
      const asJs = fileURLToPath(target)
      if (!existsSync(asJs)) {
        const asTs = `${asJs.slice(0, -3)}.ts`
        if (existsSync(asTs)) {
          // 不指定 format：让 Node 按 `.ts` 后缀自己判定走 ESM 类型剥离。
          return { url: pathToFileURL(asTs).href, shortCircuit: true }
        }
      }
    }
  }
  return next(specifier, context)
}
