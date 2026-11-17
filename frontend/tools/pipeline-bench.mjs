/**
 * 端到端量化：把真实归档按 1.2.6 的编排真跑一遍（只写内存，不写 IndexedDB），
 * 分别给出「只导正文」与「正文 + 图片」的耗时、实际读取字节数、堆峰值，
 * 用来对比 v1.2.5 那条「整包读入 → 暂存 → 整体提交」的路。
 *
 * 用法：node --import ./tools/run-ts.mjs tools/pipeline-bench.mjs <归档路径>
 */
import { openHistoryArchive } from '../src/services/chat/history/archive.ts'
import { runImport } from '../src/services/chat/history/importPipeline.ts'
import { openFileSource } from './file-source.mjs'

const path = process.argv[2]
if (path === undefined) {
  throw new Error('usage: pipeline-bench.mjs <archive.zip>')
}

let readBytes = 0
const source = await openFileSource(path, (bytes) => {
  readBytes += bytes
})
const { size } = source

let peakRss = 0
const sampler = setInterval(() => {
  peakRss = Math.max(peakRss, process.memoryUsage().rss)
}, 50)
const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`

const bench = async (label, includeAttachments) => {
  readBytes = 0
  peakRss = process.memoryUsage().rss
  const started = Date.now()
  const archive = await openHistoryArchive(source)
  let writtenBytes = 0
  let writtenFiles = 0
  let progressCalls = 0
  const result = await runImport(
    archive,
    {
      putSession: async (session, files) => {
        writtenBytes += JSON.stringify(session).length
        writtenFiles += files.length
        for (const file of files) {
          writtenBytes += file.blob.size
        }
      },
    },
    { includeAttachments },
    () => {
      progressCalls += 1
    }
  )
  const elapsed = Date.now() - started
  peakRss = Math.max(peakRss, process.memoryUsage().rss)
  console.log(
    `${label}\n  会话 ${result.imported}（跳过 ${result.skipped}）· 附件 ${result.files} 个\n` +
      `  耗时 ${elapsed} ms · 读取压缩字节 ${mb(readBytes)}（${((readBytes / size) * 100).toFixed(0)}% 整包）\n` +
      `  将写入本地 ${mb(writtenBytes)}（原件 ${writtenFiles} 个）· 堆峰值 ${mb(peakRss)} · 进度回调 ${progressCalls} 次\n`
  )
}

await bench('只导正文（默认口径，>128 MB 的归档）', false)
await bench('正文 + 图片附件', true)

clearInterval(sampler)
