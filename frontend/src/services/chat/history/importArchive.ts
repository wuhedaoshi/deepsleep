/**
 * 导入的存储接线：把编排层需要的「写一个会话」直接落到 IndexedDB。
 *
 * 没有暂存库、也没有最后的整体拷贝：会话与原件随解析进度写入，
 * 中断后已经写进去的会话在库里可用，下次导入带上 `done` 就只补没写的。
 */
import * as db from '../db.js'
import { runImport, type ImportOptions, type ImportProgress, type ImportResult } from './importPipeline.js'
import type { HistoryArchive } from './archive.js'

export type { ImportOptions, ImportProgress, ImportResult } from './importPipeline.js'

/** 导入归档：只读、按会话推进。归档已由调用方打开（校验过版本与结构）。 */
export const importArchive = (
  archive: HistoryArchive,
  options: ImportOptions,
  onProgress?: (progress: ImportProgress) => void
): Promise<ImportResult> =>
  runImport(
    archive,
    { putSession: (session, files) => db.putHistorySession(session, files) },
    options,
    onProgress
  )
