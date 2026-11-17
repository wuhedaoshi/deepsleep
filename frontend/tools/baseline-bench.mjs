/**
 * 两条对照曲线：
 * 1. v1.2.5 的入口开销——把整包读成一块块再拼成一份（`new File(chunks)` 的等价动作）；
 * 2. 1.2.6 里最大的那个会话单独读要多少堆。
 *
 * 用法：node --expose-gc --import ./tools/run-ts.mjs tools/baseline-bench.mjs <归档路径>
 */
import { createReadStream } from 'node:fs'

import { openFileSource } from './file-source.mjs'
import { openHistoryArchive } from '../src/services/chat/history/archive.ts'

const path = process.argv[2]
if (path === undefined) {
  throw new Error('usage: baseline-bench.mjs <archive.zip>')
}

const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`
const gc = () => {
  if (typeof global.gc === 'function') {
    global.gc()
  }
}
const rss = () => process.memoryUsage().rss

let peak = rss()
const sampler = setInterval(() => {
  peak = Math.max(peak, rss())
}, 30)

// ---- 1. 整包读入（v1.2.5 第一步） ----
gc()
const beforeBuffer = rss()
const started = Date.now()
const chunks = []
for await (const chunk of createReadStream(path, { highWaterMark: 64 * 1024 })) {
  chunks.push(new Uint8Array(chunk))
}
const sliceMs = Date.now() - started
const afterChunks = rss()

const bufferStart = Date.now()
let total = 0
for (const chunk of chunks) {
  total += chunk.length
}
const joined = new Uint8Array(total)
let offset = 0
for (const chunk of chunks) {
  joined.set(chunk, offset)
  offset += chunk.length
}
const joinMs = Date.now() - bufferStart
const afterJoin = rss()
console.log(
  `整包读入（v1.2.5）：分块 ${chunks.length} 个 · ${sliceMs} ms · 再拼一份 ${joinMs} ms\n` +
    `  堆增量：分块后 ${mb(afterChunks - beforeBuffer)}，拼成整块后 ${mb(afterJoin - beforeBuffer)}（合计约 ${mb(afterJoin - beforeBuffer)} 常驻）\n`
)
void joined
chunks.length = 0

gc()
// ---- 2. 最大会话单独读 ----
const source = await openFileSource(path)
const archive = await openHistoryArchive(source)
const ref = [...archive.refs].sort((left, right) => right.bytes - left.bytes)[0]
gc()
// 上一阶段的分块/整块已经释放，重新起算峰值。
peak = rss()
const beforeBig = rss()
const bigStart = Date.now()
const session = await archive.sessionOf(ref)
const bigMs = Date.now() - bigStart
const afterBig = rss()
console.log(
  `最大会话：${mb(ref.bytes)} 明文 / ${session.messages.length} 条消息\n` +
    `  解析耗时 ${bigMs} ms · 堆增量 ${mb(afterBig - beforeBig)}（本阶段峰值 ${mb(peak)}）\n`
)
clearInterval(sampler)


