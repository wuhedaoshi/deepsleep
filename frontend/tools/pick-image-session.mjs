// 从一个已有归档里挑「最短、且第一条提问就带图片」的会话，单独导成小包，
// 用于在模拟器上验证图片预览（不用滚动就能看到图）。
import { openAsBlob, writeFileSync } from 'node:fs'
import { openHistoryArchive } from '../src/services/chat/history/archive.ts'
import { exportArchive } from '../src/services/chat/history/exportArchive.ts'

const archive = await openHistoryArchive(await openAsBlob(process.argv[2]))
const out = process.argv[3]

let best = null
for (const ref of archive.refs) {
  const session = await archive.sessionOf(ref)
  const firstUser = session.messages.find((message) => message.role === 'user')
  const images = firstUser?.files.filter((file) => file.isImage) ?? []
  if (images.length === 0) continue
  if (best === null || session.messages.length < best.session.messages.length) {
    best = { ref, session, images }
  }
}
if (best === null) throw new Error('没有找到第一条消息就带图片的会话')
console.log(`选中 ${best.ref.id}：${best.session.messages.length} 条消息，首条带 ${best.images.length} 张图`)

const blob = await exportArchive({
  sessions: (async function* () {
    yield best.session
  })(),
  file: async (id) => {
    const attachment = archive.fileOf(best.ref.id, id)
    return attachment === undefined ? undefined : archive.attachmentBlob(attachment)
  },
})
writeFileSync(out, new Uint8Array(await blob.arrayBuffer()))
console.log(`已写出（${(blob.size / 1024).toFixed(0)} KB）`)
