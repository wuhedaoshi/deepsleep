// 跨平台的清空 dist：原来 package.json 里写的是 `rm -rf dist`，Windows 上跑不了。
import { rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
rmSync(join(root, 'dist'), { recursive: true, force: true })
