/**
 * 把真实归档里的前 N 个会话导出成本地文件（官方 v3 格式），用来做跨线验证：
 * 把文件 adb push 进模拟器，用实验线（1.3.6）或官方网页版去导入，看能不能吃下。
 *
 * 用法：node --import ./tools/run-ts.mjs tools/export-file.mjs <源归档> <会话数> <输出.zip>
 */
import { createWriteStream, closeSync, fstatSync, openSync, readSync } from 'node:fs'
import { once } from 'node:events'

import { openHistoryArchive } from '../src/services/chat/history/archive.ts'
import { exportArchiveTo } from '../src/services/chat/history/exportArchive.ts'

const [sourcePath, countArg, outPath] = process.argv.slice(2)
if (sourcePath === undefined || countArg === undefined || outPath === undefined) {
  throw new Error('usage: export-file.mjs <source.zip> <session-count> <out.zip>')
}

const count = Number(countArg)
const fd = openSync(sourcePath, 'r')
const { size } = fstatSync(fd)
const source = {
  size,
  slice: (start, end) => ({
    arrayBuffer: async () => {
      const length = Math.max(0, Math.min(end, size) - start)
      const buffer = Buffer.allocUnsafe(length)
      let read = 0
      while (read < length) {
        const chunk = readSync(fd, buffer, read, length - read, start + read)
        if (chunk <= 0) {
          break
        }
        read += chunk
      }
      return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + read)
    },
  }),
}

const archive = await openHistoryArchive(source)
const refs = [...archive.refs].sort((left, right) => left.bytes - right.bytes).slice(0, count)

const sessions = []
const blobs = new Map()
for (const ref of refs) {
  sessions.push(await archive.sessionOf(ref))
  for (const attachment of archive.attachmentsOf(ref.id)) {
    const blob = await archive.attachmentBlob(attachment)
    if (blob !== undefined) {
      blobs.set(attachment.id, blob)
    }
  }
}

async function* iterate() {
  for (const session of sessions) {
    yield session
  }
}

const out = createWriteStream(outPath)
let bytes = 0
await exportArchiveTo(
  { sessions: iterate(), file: async (id) => blobs.get(id) },
  async (chunk) => {
    bytes += chunk.length
    if (!out.write(Buffer.from(chunk))) {
      await once(out, 'drain')
    }
  }
)
out.end()
await once(out, 'finish')
closeSync(fd)
console.log(
  `导出 ${sessions.length} 个会话 / ${blobs.size} 个原件 → ${outPath}（${(bytes / 1024 / 1024).toFixed(1)} MB）`
)
