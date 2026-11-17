/**
 * 用真实的归档在 Node 里跑一遍 1.2.6 的导入链路（ZIP → 会话 → 附件），不写数据库：
 * 验证「不解整包」的实现能读完 300~500 MB 的包，并给出每段的耗时与堆峰值。
 *
 * 用法：
 *   node --import ./tools/run-ts.mjs tools/import-dryrun.mjs <归档路径> [--attachments] [--limit=N]
 */
import { openHistoryArchive } from '../src/services/chat/history/archive.ts'
import { sessionFromArchive } from '../src/services/chat/history/toLocal.ts'
import { openFileSource } from './file-source.mjs'

const args = process.argv.slice(2)
const path = args.find((value) => !value.startsWith('--'))
const limitArg = args.find((value) => value.startsWith('--limit='))
const limit = limitArg === undefined ? 0 : Number(limitArg.slice('--limit='.length))
const withAttachments = args.includes('--attachments')

if (path === undefined) {
  throw new Error('usage: import-dryrun.mjs <archive.zip> [--attachments] [--limit=N]')
}

const source = await openFileSource(path)

let peakRss = 0
const sample = () => {
  peakRss = Math.max(peakRss, process.memoryUsage().rss)
}
const timer = setInterval(sample, 50)

const now = () => Number(process.hrtime.bigint() / 1000n) / 1000
const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`

const started = now()
const archive = await openHistoryArchive(source)
const listingMs = now() - started
sample()

console.log(
  `archive  format=${archive.summary.format} v${archive.summary.version} ` +
    `sessions=${archive.summary.sessions} attachments=${archive.summary.attachments} ` +
    `plain=${mb(archive.summary.totalBytes)} open=${listingMs.toFixed(0)}ms`
)

const refs = limit > 0 ? archive.refs.slice(0, limit) : archive.refs
const timings = []
let imported = 0
let skipped = []
let messages = 0
let files = 0
let filesFound = 0
let attachmentBytes = 0
let worst = { title: '', ms: 0, bytes: 0, messages: 0 }

for (const ref of refs) {
  const start = now()
  try {
    const raw = await archive.readSession(ref)
    const mimeTypeOf = archive.mimeTypeOf(ref.id)
    const session = sessionFromArchive(raw, archive.summary.format, mimeTypeOf)
    const elapsed = now() - start
    imported += 1
    messages += session.messages.length
    for (const message of session.messages) {
      if (message.role !== 'user') {
        continue
      }
      for (const file of message.files) {
        files += 1
        if (file.mimeType !== '') {
          filesFound += 1
        }
      }
    }
    if (elapsed > worst.ms) {
      worst = {
        title: session.title.slice(0, 24),
        ms: elapsed,
        bytes: ref.bytes,
        messages: session.messages.length,
      }
    }
    timings.push(elapsed)
    if (withAttachments) {
      for (const attachment of archive.attachmentsOf(ref.id)) {
        const blob = await archive.attachmentBlob(attachment)
        if (blob !== undefined) {
          attachmentBytes += blob.size
        }
      }
    }
  } catch (error) {
    skipped.push({ id: ref.id, reason: String(error?.message ?? error) })
  }
  if (imported % 50 === 0) {
    sample()
    process.stdout.write(
      `  ${imported}/${refs.length}  ${mb(process.memoryUsage().rss)}  ${(now() - started).toFixed(0)}ms\n`
    )
  }
}
const totalMs = now() - started

timings.sort((left, right) => left - right)
const median = timings.length === 0 ? 0 : timings[Math.floor(timings.length / 2)]
const p95 = timings.length === 0 ? 0 : timings[Math.floor(timings.length * 0.95)]

console.log(`
结果
  sessions    导入 ${imported} / ${refs.length}，跳过 ${skipped.length}，消息 ${messages} 条
  attachments 引用 ${files} 个（归档里找到原件 ${filesFound} 个${withAttachments ? `，读回 ${mb(attachmentBytes)}` : '，未读取'}）
  耗时        总计 ${totalMs.toFixed(0)} ms，中位 ${median.toFixed(1)} ms/会话，p95 ${p95.toFixed(1)} ms
  最慢        ${worst.title}  ${worst.ms.toFixed(0)} ms / ${mb(worst.bytes)} / ${worst.messages} 条
  堆峰值      rss ${mb(peakRss)}
`)
if (skipped.length > 0) {
  console.log('跳过明细（前 10 条）')
  for (const item of skipped.slice(0, 10)) {
    console.log(`  ${item.id}  ${item.reason}`)
  }
}

clearInterval(timer)

