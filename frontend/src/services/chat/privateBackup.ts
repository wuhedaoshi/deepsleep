import type { ChunkSink } from './history/exportArchive.js'
import type { ZipSource } from './history/zip.js'

type BackupBridge = {
  listPrivateBackups(): string
  beginPrivateBackup(): boolean
  appendPrivateBackup(chunk: string): boolean
  finishPrivateBackup(): boolean
  abortPrivateBackup(): void
  readPrivateBackup(name: string, offset: number, size: number): string
}
const bridge = () => (globalThis as { __deepsleepNative?: BackupBridge }).__deepsleepNative
const chunkSize = 512 * 1024

export const hasPrivateBackups = () => typeof bridge()?.beginPrivateBackup === 'function'

export const PRIVATE_BACKUPS_CHANGED = 'deepsleep-private-backups-changed'

export const listPrivateBackups = () => {
  const raw = bridge()?.listPrivateBackups?.() ?? ''
  return raw.split('\n').flatMap((row) => {
    const match = /^(auto-(\d+)\.zip):(\d+)$/.exec(row)
    if (!match) {
      return []
    }
    const [, name, date, length] = match
    const timestamp = Number(date)
    const size = Number(length)
    return Number.isSafeInteger(timestamp) && Number.isSafeInteger(size) && size > 0
      ? [{ name, timestamp, size }]
      : []
  })
}

export const latestPrivateBackup = () => listPrivateBackups()[0]

export const savePrivateBackup = async (write: (sink: ChunkSink) => Promise<void>) => {
  const native = bridge()
  if (!native?.beginPrivateBackup?.()) {
    throw new Error('PRIVATE_BACKUP_OPEN_FAILED')
  }
  try {
    await write(async (chunk) => {
      for (let at = 0; at < chunk.length; at += chunkSize) {
        const end = Math.min(at + chunkSize, chunk.length)
        let text = ''
        for (let offset = at; offset < end; offset += 8192) {
          text += String.fromCharCode(...chunk.subarray(offset, Math.min(offset + 8192, end)))
        }
        if (!native.appendPrivateBackup(btoa(text))) {
          throw new Error('PRIVATE_BACKUP_WRITE_FAILED')
        }
        await new Promise((resolve) => setTimeout(resolve, 0))
      }
    })
    if (!native.finishPrivateBackup()) {
      throw new Error('PRIVATE_BACKUP_COMMIT_FAILED')
    }
    globalThis.dispatchEvent?.(new Event(PRIVATE_BACKUPS_CHANGED))
  } catch (error) {
    native.abortPrivateBackup()
    throw error
  }
}

export const openPrivateBackup = (name?: string): ZipSource | undefined => {
  const backups = listPrivateBackups()
  const current = name ? backups.find((backup) => backup.name === name) : backups[0]
  const native = bridge()
  if (!current || !native) {
    return undefined
  }
  return {
    size: current.size,
    slice: (start, end) => ({
      arrayBuffer: async () => {
        const bytes = new Uint8Array(end - start)
        for (let offset = start; offset < end; offset += chunkSize) {
          const length = Math.min(chunkSize, end - offset)
          const binary = atob(native.readPrivateBackup(current.name, offset, length))
          if (binary.length !== length) {
            throw new Error('PRIVATE_BACKUP_READ_FAILED')
          }
          for (let at = 0; at < length; at += 1) {
            bytes[offset - start + at] = binary.charCodeAt(at)
          }
        }
        return bytes.buffer
      },
    }),
  }
}
