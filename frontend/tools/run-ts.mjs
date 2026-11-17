/**
 * 让 Node 直接 import 仓库里的 `.ts`：注册 `ts-rewrite.mjs`，把源码里 `./x.js`
 * 的写法改指到同名 `.ts`。用法：`node --import ./tools/run-ts.mjs tools/import-dryrun.mjs`
 */
import { register } from 'node:module'

register('./ts-rewrite.mjs', import.meta.url)
