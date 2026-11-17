/**
 * 导入编排：把归档里的会话一个个解压、转换、写进本地库，全程只持有当前这一个会话。
 *
 * 与 v1.2.5 的区别：不再「先整包读进内存 → 全部校验 → 暂存 → 一次性提交」。
 * 372 MB 的包在手机上读成 File 就要 700 MB 堆，提交时还要把 450 MB 再拷一遍，
 * 这条路走不通；改成按会话推进后，峰值只由最大的那个会话决定。
 *
 * 起点是「本地数据已经被清空」：调用方负责清库与失败时的界面处理，
 * 这里只管写。写了一半中断，已写入的会话留在库里，下次可以用 `done` 续传。
 */
import type { ArchiveAttachment, ArchiveRef, HistoryArchive } from './archive.js'
import { BackupError } from './errors.js'
import { sessionFromArchive } from './toLocal.js'
import type { Session } from '../types.js'

export type ImportedFile = { id: string; blob: Blob }

export type ImportOptions = {
  /** 是否把图片等原件一起写入本地库；关闭时附件只留元数据，聊天里显示文件名 */
  includeAttachments: boolean
  /** 断点续传：这些会话 id 已经在库里，直接跳过 */
  done?: readonly string[]
}

export type ImportProgress = {
  phase: 'writing'
  /** 已处理的会话数（含跳过的） */
  done: number
  total: number
  /** 已写入的明文字节数，用来显示总量而不是只有个数 */
  bytes: number
  totalBytes: number
  /** 正在写的会话标题，给进度条下面一行文案用 */
  title: string
}

export type ImportResult = {
  imported: number
  skipped: number
  files: number
  bytes: number
}

export type ImportSink = {
  putSession(session: Session, files: readonly ImportedFile[]): Promise<void>
}

/** 附件并发读取数：手机上 2 个已经能占满闪存带宽，再多只是抢内存。 */
const FILE_CONCURRENCY = 2

/** 先写小会话：进度条很快过半，最大的那个排在最后，卡住也不影响别的会话已经能用。 */
const bySize = (left: ArchiveRef, right: ArchiveRef): number => left.bytes - right.bytes

const referencedFiles = (
  archive: HistoryArchive,
  session: Session,
  sessionId: string
): { id: string; attachment: ArchiveAttachment }[] => {
  const wanted: { id: string; attachment: ArchiveAttachment }[] = []
  const seen = new Set<string>()
  for (const message of session.messages) {
    if (message.role !== 'user') {
      continue
    }
    for (const file of message.files) {
      if (seen.has(file.id)) {
        continue
      }
      const attachment = archive.fileOf(sessionId, file.id)
      if (attachment === undefined) {
        continue
      }
      seen.add(file.id)
      wanted.push({ id: file.id, attachment })
    }
  }
  return wanted
}

/** 读原件；损坏或缺失的跳过，聊天里那条附件退化成只有文件名。 */
const readFiles = async (
  archive: HistoryArchive,
  session: Session,
  sessionId: string
): Promise<ImportedFile[]> => {
  const wanted = referencedFiles(archive, session, sessionId)
  const files: ImportedFile[] = []
  for (let at = 0; at < wanted.length; at += FILE_CONCURRENCY) {
    const batch = await Promise.all(
      wanted.slice(at, at + FILE_CONCURRENCY).map(async (item) => {
        const blob = await archive.attachmentBlob(item.attachment)
        return blob === undefined ? undefined : { id: item.id, blob }
      })
    )
    for (const item of batch) {
      if (item !== undefined) {
        files.push(item)
      }
    }
  }
  return files
}

/**
 * 逐个会话导入。`sink` 只要求「写一个会话」，测试里可以换成内存实现。
 * 单个会话结构损坏只跳过并计数；存储层抛错则整体中止（磁盘满了再继续没有意义）。
 */
export const runImport = async (
  archive: HistoryArchive,
  sink: ImportSink,
  options: ImportOptions,
  onProgress?: (progress: ImportProgress) => void
): Promise<ImportResult> => {
  const alreadyDone = new Set(options.done ?? [])
  const refs = [...archive.refs].sort(bySize)
  const total = refs.length
  // 分母按本次真的要写的量算：不导附件时若用整包总量，进度条会卡在个位数。
  const plannedBytes = refs.reduce(
    (sum, ref) => sum + ref.bytes + (options.includeAttachments ? ref.attachmentBytes : 0),
    0
  )
  let imported = 0
  let skipped = 0
  let files = 0
  let bytes = 0
  const report = (title: string) =>
    onProgress?.({
      phase: 'writing',
      done: imported + skipped,
      total,
      bytes,
      totalBytes: plannedBytes,
      title,
    })
  report('')
  for (const ref of refs) {
    if (alreadyDone.has(ref.id)) {
      // 续传时这些会话上一轮已经写进去了，字节数照算，进度才走得完。
      skipped += 1
      bytes += ref.bytes
      continue
    }
    let session: Session
    try {
      const raw = await archive.readSession(ref)
      session = sessionFromArchive(raw, archive.summary.format, archive.mimeTypeOf(ref.id))
    } catch (error) {
      if (error instanceof BackupError) {
        skipped += 1
        bytes += ref.bytes
        report('')
        continue
      }
      throw error
    }
    // 列表里的标题与置顶以索引为准：导出时索引记录的就是改名、置顶之后的状态。
    const merged: Session = {
      ...session,
      ...(ref.title === '' ? {} : { title: ref.title }),
      ...(ref.pinned ? { pinned: true } : {}),
    }
    const originals = options.includeAttachments
      ? await readFiles(archive, merged, ref.id)
      : []
    await sink.putSession(merged, originals)
    imported += 1
    files += originals.length
    bytes += ref.bytes
    for (const file of originals) {
      bytes += file.blob.size
    }
    report(merged.title)
  }
  if (skipped > 0) {
    report('')
  }
  return { imported, skipped, files, bytes }
}
