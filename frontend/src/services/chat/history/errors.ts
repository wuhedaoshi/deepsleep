import type { TranslationKey } from '../../../i18n/index.js'

/** 归档格式或内容不符合预期；`key` 是可以直接展示的文案，界面不再区分具体原因。 */
export class BackupError extends Error {
  readonly key: TranslationKey

  constructor(key: TranslationKey) {
    super(key)
    this.name = 'BackupError'
    this.key = key
  }
}

/**
 * 归档导入会抛出的错误码全集。
 *
 * 日志只认这张表：`BackupError.message` 就是翻译键，但「看起来像键」的字符串同样能塞进任何
 * `new Error(...)`，直接把 message 抄进日志等于把不受控文本落盘。这里改成白名单后，
 * 日志里出现的每一个码都是本仓库自己写死的文案键，不含任何用户数据。
 */
export const BACKUP_ERROR_KEYS = [
  'backupIncomplete',
  'backupInvalidBranches',
  'backupInvalidFiles',
  'backupInvalidJson',
  'backupInvalidVersion',
  'backupNewerVersion',
  'backupTooLarge',
  'backupUnrecognized',
] as const satisfies readonly TranslationKey[]

const BACKUP_ERROR_KEY_SET: ReadonlySet<string> = new Set(BACKUP_ERROR_KEYS)

export const isBackupErrorKey = (key: unknown): key is TranslationKey =>
  typeof key === 'string' && BACKUP_ERROR_KEY_SET.has(key)
