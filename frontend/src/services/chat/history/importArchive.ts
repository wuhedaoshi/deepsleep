/** 按会话解析归档并写入暂存；发布提交由备份流程负责。 */
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
