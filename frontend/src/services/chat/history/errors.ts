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
