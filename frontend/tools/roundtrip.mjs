/**
 * 往返校验：真实归档 → 本地 Session → 导出为 v4 归档 → 再导入，逐条比对内容。
 *
 * 覆盖 `exportArchive` 与 `sessionFromArchive` 的 `local` 分支——官方 v3 归档的读取由
 * `import-dryrun.mjs` 覆盖，这里补上「自己导出的包自己吃得下」。
 *
 * 用法：node --import ./tools/run-ts.mjs tools/roundtrip.mjs <归档路径> [--count=12]
 */
import { openHistoryArchive } from '../src/services/chat/history/archive.ts'
import { exportArchive } from '../src/services/chat/history/exportArchive.ts'
import { openFileSource } from './file-source.mjs'

const args = process.argv.slice(2)
const path = args.find((value) => !value.startsWith('--'))
const countArg = args.find((value) => value.startsWith('--count='))
const count = countArg === undefined ? 12 : Number(countArg.slice('--count='.length))

if (path === undefined) {
  throw new Error('usage: roundtrip.mjs <archive.zip> [--count=N]')
}

const source = await openFileSource(path)

const archive = await openHistoryArchive(source)
const refs = [...archive.refs].sort((left, right) => right.bytes - left.bytes).slice(0, count)
console.log(`源归档 ${refs.length} 个会话（按体积取最大的 ${count} 个），开始转换`)

// 只留这几个会话用得到的原件，别把 300 MB 图片全读进来。
const blobs = new Map()
const sessions = []
for (const ref of refs) {
  const session = await archive.sessionOf(ref)
  sessions.push({ ...session, pinned: ref.pinned })
  for (const attachment of archive.attachmentsOf(ref.id)) {
    const blob = await archive.attachmentBlob(attachment)
    if (blob !== undefined) {
      blobs.set(attachment.id, blob)
    }
  }
}
const sourceBytes = sessions.reduce(
  (sum, session) => sum + JSON.stringify(session).length,
  0
)
console.log(
  `转换完成：${sessions.length} 个会话、${sessions.reduce((sum, item) => sum + item.messages.length, 0)} 条消息、` +
    `原件 ${blobs.size} 个、正文 ${(sourceBytes / 1024 / 1024).toFixed(1)} MB`
)

async function* iterate() {
  for (const session of sessions) {
    yield session
  }
}

const started = Date.now()
const exported = await exportArchive({
  sessions: iterate(),
  file: async (id) => blobs.get(id),
})
const written = await exported.arrayBuffer()
console.log(
  `导出完成：${(written.byteLength / 1024 / 1024).toFixed(1)} MB，${Date.now() - started} ms`
)

const reopened = await openHistoryArchive(new Blob([written]))
console.log(
  `重新打开：format=${reopened.summary.format} v${reopened.summary.version} ` +
    `sessions=${reopened.summary.sessions} attachments=${reopened.summary.attachments}`
)

const byId = new Map(sessions.map((session) => [session.id, session]))
let checked = 0
const failures = []

/**
 * 导出成官方 v3 时消息 id 会被重编号成 1..N（官方解析器要求整数），所以不能逐字节比。
 * 这里比「用户看得到的东西」：标题、时间、消息顺序、每条的正文/思考/工具块、附件。
 */
const projection = (session) => ({
  title: session.title,
  createdAt: session.createdAt,
  updatedAt: session.updatedAt,
  messages: session.messages.map((message) =>
    message.role === 'user'
      ? {
          role: 'user',
          createdAt: message.createdAt,
          content: message.content,
          files: message.files.map((file) => `${file.id}/${file.name}/${file.isImage}`),
        }
      : {
          role: 'assistant',
          createdAt: message.createdAt,
          status: message.status,
          blocks: message.blocks.map((block) => {
            if (block.type === 'text') {
              return `text:${block.isTemplate === true ? 'tpl:' : ''}${block.text}`
            }
            if (block.type === 'thinking') {
              return `think:${block.thinking}`
            }
            if (block.type === 'server_tool_use') {
              // kind（search / deep_search）是本地从 fragment 组合推导出来的派生字段，
              // 官方格式里没有对应字段，跨格式往返必然按官方规则重算，所以不参与比较。
              return `use:${JSON.stringify(block.input)}`
            }
            // 工具结果块：tool_use_id 随重编号变化、kind 是派生的，只比类型。
            return `result:${block.type}`
          }),
        }
  ),
})

for (const ref of reopened.refs) {
  const original = byId.get(ref.id)
  if (original === undefined) {
    failures.push({ id: ref.id, reason: 'unexpected session' })
    continue
  }
  const restored = await reopened.sessionOf(ref)
  const left = JSON.stringify(projection(original))
  const right = JSON.stringify(projection(restored))
  if (left !== right) {
    let at = 0
    while (at < left.length && left[at] === right[at]) {
      at += 1
    }
    failures.push({
      id: ref.id,
      reason: `content differs at ${at}: …${left.slice(Math.max(0, at - 60), at + 60)}… vs …${right.slice(Math.max(0, at - 60), at + 60)}…`,
    })
    continue
  }
  checked += 1
}

const originals = [...blobs.entries()]
// 归档里可能留着已经不在当前分支上的附件原件；导出只带消息引用到的那些，比对也只看它们。
const referenced = new Set()
for (const session of sessions) {
  for (const message of session.messages) {
    if (message.role !== 'user') {
      continue
    }
    for (const file of message.files) {
      referenced.add(`${session.id}/${file.id}`)
    }
  }
}
let filesChecked = 0
let filesSkipped = 0
for (const [id, blob] of originals) {
  const session = sessions.find((item) =>
    item.messages.some(
      (message) => message.role === 'user' && message.files.some((file) => file.id === id)
    )
  )
  if (session === undefined || !referenced.has(`${session.id}/${id}`)) {
    filesSkipped += 1
    continue
  }
  const attachment = reopened.fileOf(session.id, id)
  if (attachment === undefined) {
    failures.push({ id, reason: 'attachment missing from export' })
    continue
  }
  const restored = await reopened.attachmentBlob(attachment)
  if (restored === undefined || restored.size !== blob.size) {
    failures.push({ id, reason: 'attachment bytes differ' })
    continue
  }
  filesChecked += 1
}

console.log(
  `比对结果：会话 ${checked}/${reopened.refs.length} 一致，原件 ${filesChecked}/${originals.length - filesSkipped} 一致` +
    `（另有 ${filesSkipped} 个未被当前分支引用的原件不参与导出）`
)

/**
 * 结构对照：把「原始官方 JSON」与「我们导出的 JSON」都拍平成 key 路径集合再比。
 * 这是能离线做的最接近「官方能不能吃下」的检查——值可以不同（id 重编号），形状必须一致。
 */
const shape = (value, path = '$', into = new Set()) => {
  if (Array.isArray(value)) {
    for (const item of value) {
      shape(item, `${path}[]`, into)
    }
    return into
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      shape(child, `${path}.${key}`, into)
    }
  } else {
    into.add(path)
  }
  return into
}

const sample = [...reopened.refs].sort((left, right) => left.bytes - right.bytes)[0]
const originalRaw = await archive.readSession(archive.refs.find((ref) => ref.id === sample.id))
const exportedRaw = await reopened.readSession(sample)
const originalShape = shape(originalRaw)
const exportedShape = shape(exportedRaw)
const missing = [...originalShape].filter((path) => !exportedShape.has(path))
const added = [...exportedShape].filter((path) => !originalShape.has(path))
console.log(
  `结构对照（${sample.id}）：官方有而我们没有的字段 ${missing.length} 个，我们多出来的 ${added.length} 个`
)
if (missing.length > 0) {
  console.log('  缺失（官方导入器可能要求）')
  for (const path of missing.slice(0, 12)) {
    console.log(`    ${path}`)
  }
}
if (added.length > 0) {
  console.log('  多出（官方多半会忽略）')
  for (const path of added.slice(0, 8)) {
    console.log(`    ${path}`)
  }
}
if (failures.length > 0) {
  console.log('不一致明细')
  for (const item of failures.slice(0, 10)) {
    console.log(`  ${item.id}  ${item.reason}`)
  }
  process.exitCode = 1
}

