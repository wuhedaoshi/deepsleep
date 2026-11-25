/**
 * 归档清单：只从 ZIP 中央目录和 `chat_session_index.json` 建索引，不解压任何会话正文。
 *
 * 这样「打开归档」是 O(entry 数)、毫秒级，界面可以立刻给出总数与总量，
 * 真正的正文按会话逐个解压，内存里只留当前这一个。
 */
import { BackupError } from './errors.js'
import { parseAttachmentPath, parseSessionPath, readSessionId, safePathSegment, sessionFilesDir } from './paths.js'
import { sessionFromArchive, type ArchiveFormat } from './toLocal.js'
import { ZipArchive, ZipError, type ZipSource } from './zip.js'

/** 官方导出格式版本。 */
const OFFICIAL_VERSION = 3
/** 本应用 1.2.6 的本地格式版本，会话 JSON 即本地结构。 */
const LOCAL_VERSION = 4
const LOCAL_MARKER = 'local-v1'

// 会话 id 与附件条目名的规则统一在 paths.ts：导入与导出共用同一套，
// 避免出现「能导出却导不回来」（含点 id）这类单向规则。

const IMAGE_EXTENSIONS: ReadonlySet<string> = new Set([
  'jpg',
  'jpeg',
  'png',
  'webp',
  'gif',
  'bmp',
  'heic',
  'heif',
])

const MIME_BY_EXTENSION: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  bmp: 'image/bmp',
  heic: 'image/heic',
  heif: 'image/heif',
  pdf: 'application/pdf',
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  json: 'application/json',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
}

const extensionOf = (name: string): string => {
  const dot = name.lastIndexOf('.')
  return dot < 0 ? '' : name.slice(dot + 1).toLowerCase()
}

export type ArchiveAttachment = {
  /** 归档内唯一的键，形如 `<会话 id>/<附件 id>` */
  key: string
  sessionId: string
  id: string
  /** 展示用的原始文件名（去掉归档加的前缀） */
  name: string
  path: string
  mimeType: string
  isImage: boolean
  size: number
}

export type ArchiveRef = {
  id: string
  /** 会话正文在包内的路径 */
  path: string
  /** 正文明文字节数，用来排导入顺序与算进度 */
  bytes: number
  attachmentBytes: number
  attachmentCount: number
  /** 索引里记录的标题与置顶；索引缺失时为空串 / false，正文解析后以正文为准 */
  title: string
  pinned: boolean
  updatedAt: number
}

export type ArchiveSummary = {
  format: ArchiveFormat
  version: number
  /** 正文 + 附件的明文总量，进度条的分母 */
  totalBytes: number
  attachments: number
  /** 会话数，来自清单 */
  sessions: number
}

type Json = Record<string, unknown>

const object = (value: unknown): Json | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Json) : null

const decodeJson = (bytes: Uint8Array): unknown => {
  try {
    return JSON.parse(new TextDecoder('utf-8').decode(bytes))
  } catch {
    throw new BackupError('backupInvalidJson')
  }
}

const indexEntry = (value: unknown): { id: string; title: string; pinned: boolean; updatedAt: number } | null => {
  const entry = object(value)
  if (!entry || typeof entry.id !== 'string' || readSessionId(entry.id) === null) {
    return null
  }
  const updated = typeof entry.updated_at === 'string' ? Date.parse(entry.updated_at) : NaN
  return {
    id: entry.id,
    title: typeof entry.title === 'string' ? entry.title : '',
    pinned: entry.pinned === true,
    updatedAt: Number.isFinite(updated) ? updated : 0,
  }
}

export class HistoryArchive {
  readonly summary: ArchiveSummary
  readonly refs: readonly ArchiveRef[]
  private readonly zip: ZipArchive
  private readonly attachmentByKey: ReadonlyMap<string, ArchiveAttachment>
  private readonly attachmentsBySession: ReadonlyMap<string, readonly ArchiveAttachment[]>
  /** 绑定后的 (sessionId/fileId) → 附件；由 `bindFiles` 在读完会话 JSON 后填充 */
  private readonly boundFiles = new Map<string, ArchiveAttachment>()

  /** 归档的索引与附件表由 `openHistoryArchive` 提供；不要直接 new 出一个半成品。 */
  constructor(
    zip: ZipArchive,
    summary: ArchiveSummary,
    refs: readonly ArchiveRef[],
    attachmentByKey: ReadonlyMap<string, ArchiveAttachment>,
    attachmentsBySession: ReadonlyMap<string, readonly ArchiveAttachment[]>
  ) {
    this.zip = zip
    this.summary = summary
    this.refs = refs
    this.attachmentByKey = attachmentByKey
    this.attachmentsBySession = attachmentsBySession
  }

  /** 归档里该会话有原件的附件；没有原件的附件只留元数据。 */
  attachmentsOf(sessionId: string): readonly ArchiveAttachment[] {
    return this.attachmentsBySession.get(sessionId) ?? []
  }

  /**
   * 会话 JSON 声明之后，把「条目路径」绑定到「fileId」。
   *
   * 为什么不从文件名拆 id：附件 id 里可能有下划线（`f_a`），懒匹配会截成 `f`，
   * 之后用会话 JSON 里的 `f_a` 查不到，原件就丢了。官方也是用 `export_path` 建索引的。
   */
  /**
   * 会话 JSON 声明之后，把「条目路径」绑定到「fileId」。
   *
   * 两条来源：
   * - 官方 v3：`FILE.export_path` 就是条目路径，精确匹配。
   * - 本地 v4：消息里没有 `fragments`，只有 `message.files[]`，按旧命名约定
   *   `chat_sessions/{sessionId}_files/{fileId}_{name}` 拼路径再匹配（v4 导出用的就是这个规则）。
   *
   * 为什么不从文件名拆 id：附件 id 里可能有下划线（`f_a`），懒匹配会截成 `f`。
   */
  private bindFiles(sessionId: string, raw: unknown): void {
    if (raw === null || typeof raw !== 'object') {
      return
    }
    const messages = (raw as { messages?: unknown }).messages
    if (!Array.isArray(messages)) {
      return
    }
    const bind = (fileId: string, path: string): void => {
      const attachment = this.attachmentByKey.get(path.normalize('NFC'))
      if (attachment === undefined) {
        return
      }
      ;(attachment as { id: string }).id = fileId
      this.boundFiles.set(`${sessionId}/${fileId}`, attachment)
    }

    // 先把本会话声明的所有 (fileId, 原始文件名) 收齐：v4 在 `message.files[]`，v3 在 `FILE.files[]`
    const declared: { id: string; name: string }[] = []
    const v3Entries: { id: string; exportPath: string }[] = []
    for (const message of messages) {
      if (message === null || typeof message !== 'object') {
        continue
      }
      const files = (message as { files?: unknown }).files
      if (Array.isArray(files)) {
        for (const entry of files) {
          const file = (entry ?? {}) as { id?: unknown; name?: unknown }
          if (typeof file.id === 'string') {
            declared.push({ id: file.id, name: typeof file.name === 'string' ? file.name : '' })
          }
        }
      }
      const fragments = (message as { fragments?: unknown }).fragments
      if (!Array.isArray(fragments)) {
        continue
      }
      for (const fragment of fragments) {
        const record = fragment as { type?: unknown; files?: unknown } | null
        if (record === null || record === undefined || record.type !== 'FILE' || !Array.isArray(record.files)) {
          continue
        }
        for (const entry of record.files) {
          const file = (entry ?? {}) as { id?: unknown; file_name?: unknown; export_path?: unknown }
          if (typeof file.id !== 'string') {
            continue
          }
          declared.push({ id: file.id, name: typeof file.file_name === 'string' ? file.file_name : '' })
          if (typeof file.export_path === 'string') {
            v3Entries.push({ id: file.id, exportPath: file.export_path })
          }
        }
      }
    }

    const dir = sessionFilesDir(sessionId)
    const bound = new Set<string>()
    const claimedPaths = new Set<string>()

    // ① 精确匹配（id + 文件名）：这是唯一不会串的判据。
    //    为什么不能只靠前缀：`f_x` + 文件名 `y_a.png` 与 `f_x_y` + `a.png` 会拼出同一个路径，
    //    按最长前缀判会把前者判给 `f_x_y`。路径撞车时只让**先声明的**拿到原件，
    //    另一个保持「只有元数据」，不会两个附件读成同一个文件。
    for (const file of declared) {
      if (bound.has(file.id)) {
        continue
      }
      const exact = `${dir}${safePathSegment(file.id)}_${safePathSegment(file.name)}`.normalize('NFC')
      if (claimedPaths.has(exact)) {
        continue
      }
      const attachment = this.attachmentByKey.get(exact)
      if (attachment !== undefined) {
        bind(file.id, attachment.path)
        bound.add(file.id)
        claimedPaths.add(exact)
      }
    }

    // ② 还没绑上的，按最长 id 前缀兜底（名字被改过、或旧归档用了别的后缀）。
    //    比较前两端统一 NFC：分解形式的 id（`fe\u0301`）否则永远匹配不上。
    const rest = [...new Set(declared.map((file) => file.id))].filter((id) => !bound.has(id))
    const longestFirst = rest.sort((left, right) => right.length - left.length)
    for (const attachment of this.attachmentsBySession.get(sessionId) ?? []) {
      const path = attachment.path.normalize('NFC')
      if (claimedPaths.has(path)) {
        continue
      }
      const owner = longestFirst.find((id) => {
        if (bound.has(id)) {
          return false
        }
        const prefix = `${dir}${safePathSegment(id)}_`.normalize('NFC')
        return path.startsWith(prefix)
      })
      if (owner !== undefined) {
        bind(owner, attachment.path)
        bound.add(owner)
        claimedPaths.add(path)
      }
    }

    // ③ v3 的 export_path 是权威来源，最后覆盖；**反向也权威**：
    //    指向的条目不存在时必须清掉前面猜出来的绑定，否则「缺原件」的附件
    //    会被显示成另一个文件的内容（导出的归档若因去重少了某件就会这样）。
    for (const entry of v3Entries) {
      const exact = entry.exportPath.normalize('NFC')
      if (this.attachmentByKey.get(exact) === undefined) {
        this.boundFiles.delete(`${sessionId}/${entry.id}`)
        continue
      }
      bind(entry.id, entry.exportPath)
    }
  }

  fileOf(sessionId: string, fileId: string): ArchiveAttachment | undefined {
    return this.boundFiles.get(`${sessionId}/${fileId}`)
  }

  /** 会话正文的 MIME 建议值：按归档内的原始文件名推，取不到时为空串。 */
  mimeTypeOf = (sessionId: string) => (fileId: string): string =>
    this.fileOf(sessionId, fileId)?.mimeType ?? ''

  /** 读并解析一个会话正文；形状不对由 `sessionFromArchive` 抛 `BackupError`。 */
  async readSession(ref: ArchiveRef): Promise<unknown> {
    const bytes = await this.zip.read(ref.path)
    return decodeJson(bytes)
  }

  /** 会话正文 → 本地 `Session`。 */
  async sessionOf(ref: ArchiveRef, localSnapshot = false) {
    const raw = await this.readSession(ref)
    // 先按 export_path 绑定附件 id，再转换：mimeTypeOf(fileId) 依赖这次绑定
    this.bindFiles(ref.id, raw)
    const session = sessionFromArchive(raw, this.summary.format, this.mimeTypeOf(ref.id))
    if (localSnapshot) {
      if (this.summary.format !== 'local' || session.id !== ref.id) {
        throw new BackupError('backupIncomplete')
      }
      // Native snapshots were produced from our own database. Preserve local fields and message IDs.
      return raw as typeof session
    }
    return session
  }

  /** 附件原件；缺失或损坏（解压失败）时返回 `undefined`，不打断整包导入。 */
  async attachmentBlob(attachment: ArchiveAttachment, verify = false): Promise<Blob | undefined> {
    try {
      // 图片在归档里是 store 条目：直接切 Blob，302 MB 原件不进 JS 堆。
      if (verify) {
        return await this.zip.verifiedBlob(attachment.path, attachment.mimeType)
      }
      const stored = await this.zip.storedBlob(attachment.path, attachment.mimeType)
      if (stored !== undefined) {
        return stored
      }
      const bytes = await this.zip.read(attachment.path, false)
      return new Blob([bytes], { type: attachment.mimeType })
    } catch (error) {
      if (error instanceof ZipError) {
        return undefined
      }
      throw error
    }
  }
}

type Scan = {
  sessions: Map<string, { path: string; size: number }>
  attachments: Map<string, ArchiveAttachment>
  bySession: Map<string, ArchiveAttachment[]>
}

/** 扫一遍 entry 名：会话正文与附件各自归档，附件按 `<会话 id>/<附件 id>` 建键。 */
const scanEntries = (zip: ZipArchive): Scan => {
  const sessions = new Map<string, { path: string; size: number }>()
  const attachments = new Map<string, ArchiveAttachment>()
  const bySession = new Map<string, ArchiveAttachment[]>()
  for (const name of zip.names) {
    const entry = zip.entry(name)
    if (entry === undefined) {
      continue
    }
    const sessionId = parseSessionPath(name)
    if (sessionId !== null) {
      sessions.set(sessionId, { path: name, size: entry.size })
      continue
    }
    const attachmentPath = parseAttachmentPath(name)
    if (attachmentPath === null) {
      continue
    }
    const { sessionId: fileSessionId, tail } = attachmentPath
    const extension = extensionOf(tail)
    const attachment: ArchiveAttachment = {
      // 不再从文件名拆 id（`f_a` 会被截成 `f`）：真正的 fileId 以会话 JSON 的
      // FILE.export_path 为准，这里先按路径登记，绑定阶段再补 id。
      key: name,
      sessionId: fileSessionId,
      id: '',
      name: tail,
      path: name,
      mimeType: MIME_BY_EXTENSION[extension] ?? '',
      isImage: IMAGE_EXTENSIONS.has(extension),
      size: entry.size,
    }
    attachments.set(attachment.key, attachment)
    const existing = bySession.get(fileSessionId)
    if (existing === undefined) {
      bySession.set(fileSessionId, [attachment])
    } else {
      existing.push(attachment)
    }
  }
  return { sessions, attachments, bySession }
}

/** 把 `chat_session_index.json` 与 JSON entry 合并成导入清单：索引提供顺序与置顶，entry 提供大小。 */
const buildRefs = (
  scan: Scan,
  index: readonly { id: string; title: string; pinned: boolean; updatedAt: number }[]
): ArchiveRef[] => {
  const jsonEntries = scan.sessions
  const totals = new Map<string, { bytes: number; count: number }>()
  for (const attachment of scan.attachments.values()) {
    const current = totals.get(attachment.sessionId) ?? { bytes: 0, count: 0 }
    current.bytes += attachment.size
    current.count += 1
    totals.set(attachment.sessionId, current)
  }
  const refs: ArchiveRef[] = []
  const seen = new Set<string>()
  for (const entry of index) {
    const json = jsonEntries.get(entry.id)
    if (json === undefined || seen.has(entry.id)) {
      continue
    }
    seen.add(entry.id)
    const total = totals.get(entry.id)
    refs.push({
      id: entry.id,
      path: json.path,
      bytes: json.size,
      attachmentBytes: total?.bytes ?? 0,
      attachmentCount: total?.count ?? 0,
      title: entry.title,
      pinned: entry.pinned,
      updatedAt: entry.updatedAt,
    })
  }
  // 索引里没有的会话（导出中断、或第三方生成的包）也要导进来，标题与时间在解析正文时再补。
  for (const [id, json] of jsonEntries) {
    if (seen.has(id)) {
      continue
    }
    const total = totals.get(id)
    refs.push({
      id,
      path: json.path,
      bytes: json.size,
      attachmentBytes: total?.bytes ?? 0,
      attachmentCount: total?.count ?? 0,
      title: '',
      pinned: false,
      updatedAt: 0,
    })
  }
  return refs
}

const readVersion = (manifest: Json): { format: ArchiveFormat; version: number } => {
  const version = manifest.export_format_version
  if (typeof version !== 'number' || !Number.isInteger(version)) {
    throw new BackupError('backupInvalidVersion')
  }
  if (version > LOCAL_VERSION) {
    throw new BackupError('backupNewerVersion')
  }
  if (version === LOCAL_VERSION) {
    if (manifest.sessions_format !== LOCAL_MARKER) {
      throw new BackupError('backupUnrecognized')
    }
    return { format: 'local', version }
  }
  if (version !== OFFICIAL_VERSION) {
    throw new BackupError('backupInvalidVersion')
  }
  return { format: 'official', version }
}

/**
 * 打开归档：读中央目录、清单与索引，不做解压。
 * 版本不认识或结构不对时抛 `BackupError`，此时还没有动过本地数据。
 */
export const openHistoryArchive = async (source: ZipSource): Promise<HistoryArchive> => {
  let zip: ZipArchive
  try {
    zip = await ZipArchive.open(source)
  } catch (error) {
    if (error instanceof ZipError) {
      throw new BackupError('backupUnrecognized')
    }
    throw error
  }
  if (!zip.has('manifest.json')) {
    throw new BackupError('backupUnrecognized')
  }
  const manifest = object(decodeJson(await zip.read('manifest.json')))
  if (manifest === null) {
    throw new BackupError('backupUnrecognized')
  }
  const { format, version } = readVersion(manifest)
  const index: { id: string; title: string; pinned: boolean; updatedAt: number }[] = []
  if (zip.has('chat_session_index.json')) {
    const parsed = decodeJson(await zip.read('chat_session_index.json'))
    for (const value of Array.isArray(parsed) ? parsed : []) {
      const entry = indexEntry(value)
      if (entry !== null) {
        index.push(entry)
      }
    }
  }
  const scan = scanEntries(zip)
  const refs = buildRefs(scan, index)
  if (refs.length === 0) {
    throw new BackupError('backupIncomplete')
  }
  const totalBytes = refs.reduce((sum, ref) => sum + ref.bytes + ref.attachmentBytes, 0)
  return new HistoryArchive(
    zip,
    {
      format,
      version,
      totalBytes,
      attachments: scan.attachments.size,
      sessions: refs.length,
    },
    refs,
    scan.attachments,
    scan.bySession
  )
}
