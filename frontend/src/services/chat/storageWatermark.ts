import { logError } from '../log.js'

type Action = 'save' | 'delete' | 'clear' | 'import'
type Watermark = { count: number; port: number; action: Action }
type NativeStorage = {
  readStorageWatermark?: () => string
  writeStorageWatermark?: (sessionCount: number, dbVersion: number, action: Action) => void
}

const nativeStorage = () =>
  (globalThis as { __deepsleepNative?: NativeStorage }).__deepsleepNative

export const inspectStorage = (count: number): boolean => {
  try {
    const raw = nativeStorage()?.readStorageWatermark?.()
    if (!raw) {
      return false
    }
    const previous = JSON.parse(raw) as Watermark
    const port = Number(globalThis.location?.port)
    const changedPort = Number.isInteger(previous.port) && previous.port > 0 &&
      port > 0 && previous.port !== port
    const unexpectedEmpty = count === 0 && previous.count > 0 && previous.action !== 'clear'
    if (changedPort || unexpectedEmpty) {
      logError('storage', '本地历史完整性检查异常', {
        count, previousCount: previous.count, changedPort, unexpectedEmpty,
      })
    }
    return changedPort || unexpectedEmpty
  } catch {
    return false
  }
}

export const hasNativeWatermark = () => nativeStorage()?.writeStorageWatermark !== undefined

export const writeStorageWatermark = (count: number, dbVersion: number, action: Action) => {
  try {
    nativeStorage()?.writeStorageWatermark?.(count, dbVersion, action)
  } catch {
    logError('storage', '无法更新原生存储水位', { action })
  }
}
