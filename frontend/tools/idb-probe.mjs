// 手工跑的真库检查：用 fake-indexeddb 起一个真实 IDB，把归档导入进去再清孤儿，
// 断言「导入的图片没有被自己的清理逻辑删掉」。
//
// 这个坑踩过两次（都是 `chat_sessions/<sid>_files/<fid>_<name>` 的 id 解析写成贪婪匹配）：
// 写进库的键变成 `<fid>_<文件名>`，而会话摘要引用的是 `<fid>`，孤儿清理于是把它们全删了。
// 症状：导入了 368 个对话但一张图都没有，导出只报 images=12/929。
//
// 用法（在 frontend 下）：
//   node --experimental-transform-types --import ./tools/run-ts.mjs tools/idb-probe.mjs <归档.zip> [样例会话数]
globalThis.__API_ORIGIN__ = 'https://api.deepseek.com'
import 'fake-indexeddb/auto'
import { openAsBlob } from 'node:fs'

const db = await import('../src/services/chat/db.ts')
const { openArchive, importArchive } = await import('../src/services/chat/history/importArchive.ts')

const [zipPath, limitArg] = process.argv.slice(2)
const limit = Number(limitArg ?? 5)

const archive = await openArchive(await openAsBlob(zipPath))
const refs = archive.refs.filter((ref) => ref.images.length > 0).slice(0, limit)
if (refs.length === 0) {
  throw new Error('这个归档里没有带图片的会话，换一个样例')
}
const expected = refs.reduce((sum, ref) => sum + ref.images.length, 0)
console.log(`样例：${refs.length} 个会话、${expected} 张图片`)

await db.clearStaging()
const result = await importArchive(
  { ...archive, refs },
  { putSession: (session, files) => db.putHistorySession(session, files) },
  { includeAttachments: true }
)

await db.commitStaging()
const sample = refs[0].images[0]
const stored = await db.loadFile(sample.id)
const pruned = await db.pruneOrphanFiles()

console.log(
  [
    `导入会话 ${result.imported}、附件 ${result.files}（期望 ${expected}）`,
    `抽样 file id ${sample.id} 可读=${stored !== undefined}（${stored?.size ?? 0} B）`,
    `孤儿清理删除 ${pruned}（期望 0）`,
  ].join('\n')
)

if (result.files !== expected || stored === undefined || pruned !== 0) {
  console.error('FAIL：附件被误删或没写进去')
  process.exitCode = 1
} else {
  console.log('PASS')
}
