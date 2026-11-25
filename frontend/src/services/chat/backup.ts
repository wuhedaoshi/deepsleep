import { hasPrivateBackups, latestPrivateBackup, openPrivateBackup, savePrivateBackup } from './privateBackup.js'
import type { ZipSource } from './history/zip.js'
import { formatDate } from '../../utils/format.js'
import { errorSummary, logError, logInfo } from '../log.js'
import * as db from './db.js'
import { BackupError } from './history/errors.js'
import type { ImportOptions, ImportProgress, ImportResult } from './history/importArchive.js'
import { replaceHistory, replaceHistoryProgressively, useChatStore } from './store.js'
import type { Session } from './types.js'

export { BackupError } from './history/errors.js'
export type { ImportOptions, ImportProgress, ImportResult } from './history/importArchive.js'

// 导入、导出与全部删除串行处理，避免读取归档时数据被清空或两个替换事务交错。
let backupQueue: Promise<unknown> = Promise.resolve()

const enqueueBackup = <T>(run: () => Promise<T>): Promise<T> => {
  const task = backupQueue.then(run)
  backupQueue = task.catch(() => {})
  return task
}

const backupFileName = (date: Date) => `deepseek_data-${formatDate(date)}.zip`

/** 超过这个体积的归档默认只导正文：附件（图片）通常占四分之三，全导在手机上很容易被打断。 */
export const ATTACHMENT_SIZE_LIMIT_MB = 128

/** 导出结果：手机上直接落盘给 `path`，桌面上退回 `blob` 由调用方触发下载。 */
export type ExportOutcome = {
  name: string
  path?: string
  blob?: Blob
}

/**
 * 导出为官方格式（v3）的 ZIP。
 *
 * 手机（APK）里必须直接写盘：WebView 没有 DownloadListener，`a.click()` 下载 blob 什么都不会发生
 * ——这就是 1.2.7 之前「点了导出没反应」的原因。落盘走 `archiveSink` 的原生桥（SAF 选位置），
 * 桌面浏览器没有桥，退回 Blob 下载。
 */
export const exportHistory = (): Promise<ExportOutcome> =>
  enqueueBackup(async () => {
    // 列表和已加载内容保留导出开始时的快照；未打开的会话逐条读取，不填满详情缓存。
    const { sessions, sessionCache } = useChatStore.getState()
    async function* readSessions(): AsyncGenerator<Session> {
      for (const summary of sessions) {
        const session = Object.hasOwn(sessionCache, summary.id)
          ? sessionCache[summary.id]
          : await db.loadSession(summary.id)
        if (!session) {
          throw new Error(`History session disappeared during export: ${summary.id}`)
        }
        // 详情读取期间可能重命名，归档标题与开始时的列表保持一致。
        yield { ...session, ...summary }
      }
    }
    const source = {
      sessions: readSessions(),
      file: (id: string) => db.loadFile(id),
    }
    const name = backupFileName(new Date())
    logInfo('storage', '开始导出历史', { sessionCount: sessions.length })
    const { canSaveToDisk, saveArchive } = await import('./history/archiveSink.js')
    if (canSaveToDisk()) {
      const { exportArchiveTo } = await import('./history/exportArchive.js')
      const path = await saveArchive(name, (sink) => exportArchiveTo(source, sink))
      logInfo('storage', '历史导出完成', { sessionCount: sessions.length })
      return { name, path }
    }
    const { exportArchive } = await import('./history/exportArchive.js')
    const blob = await exportArchive(source)
    logInfo('storage', '历史导出完成', { sessionCount: sessions.length, bytes: blob.size })
    return { name, blob }
  }).catch((error: unknown) => {
    db.reportStorageError('export history')(error)
    throw error
  })

/** 确认覆盖后分批暂存，归档完整处理后再原子替换旧历史。 */
export const importHistory = (
  file: ZipSource,
  options: ImportOptions,
  onProgress?: (progress: ImportProgress) => void
): Promise<ImportResult> =>
  enqueueBackup(async () => {
    const { openHistoryArchive } = await import('./history/archive.js')
    const { importArchive } = await import('./history/importArchive.js')
    // 时间线：先记「开始导入」与文件大小，再记结果；失败时带上错误摘要。
    // 这三条就能还原绝大多数「导入到一半白屏/失败」的现场。
    logInfo('import', `开始导入 ${(file.size / 1024 / 1024).toFixed(1)} MB，附件=${options.includeAttachments}`)
    try {
      const archive = await openHistoryArchive(file)
      logInfo('import', `归档已打开：会话=${archive.refs.length}，附件=${archive.summary.attachments}`)
      const result = await replaceHistoryProgressively(async () => {
        const imported = await importArchive(archive, options, onProgress)
        if (imported.imported === 0) {
          throw new BackupError('backupIncomplete')
        }
        return imported
      })
      logInfo(
        'import',
        `导入完成：会话=${result.imported} 跳过=${result.skipped} 附件=${result.files}`
      )
      return result
    } catch (error) {
      logError('import', '导入失败', errorSummary(error))
      throw error
    }
  })

/** 确认删除后调用：以空历史原子替换全部本地会话与附件，保留 API Key 和其他设置。 */
export const clearHistory = (): Promise<void> =>
  enqueueBackup(async () => {
    const previous = useChatStore.getState().sessions.length
    logInfo('storage', '开始清空历史', { sessionCount: previous, source: 'settings' })
    try {
      await replaceHistory(async () => {})
      logInfo('storage', '清空历史完成', { previous, sessionCount: 0 })
    } catch (error) {
      db.reportStorageError('clear history')(error)
      throw error
    }
  })

let backupScheduled = false
let nextBackupCheck = 0
const DAY_MS = 86_400_000

/** Only committed history enters the private snapshot. */
export const scheduleAutoBackup = () => {
  if (!hasPrivateBackups() || backupScheduled || Date.now() < nextBackupCheck) {
    return
  }
  backupScheduled = true
  void enqueueBackup(async () => {
    const last = latestPrivateBackup()
    if (last && Date.now() - last.timestamp < DAY_MS) {
      nextBackupCheck = last.timestamp + DAY_MS
      return
    }
    const state = useChatStore.getState()
    if (state.storageWarning || Object.keys(state.streaming).length > 0) {
      return
    }
    nextBackupCheck = Date.now() + 60_000
    const summaries = await db.loadSessionSummaries()
    if (!summaries.length) {
      return
    }
    async function* sessions() {
      for (const info of summaries) {
        const session = await db.loadSession(info.id)
        if (!session) {
          throw new Error('PRIVATE_BACKUP_SESSION_CHANGED')
        }
        yield session
      }
    }
    const { exportArchiveTo } = await import('./history/exportArchive.js')
    await savePrivateBackup((sink) => exportArchiveTo({ sessions: sessions(), file: db.loadFile, localSnapshot: true }, sink))
    nextBackupCheck = Date.now() + DAY_MS
    logInfo('storage', '自动备份已提交', { count: summaries.length })
  }).catch(db.reportStorageError('automatic backup')).finally(() => {
    backupScheduled = false
  })
}

export const restorePrivateBackup = async (name?: string): Promise<ImportResult> => {
  const source = openPrivateBackup(name)
  if (!source) {
    throw new Error('PRIVATE_BACKUP_MISSING')
  }
  return importHistory(source, { includeAttachments: true, localSnapshot: true })
}
