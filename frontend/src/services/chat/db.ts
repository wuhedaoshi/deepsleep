import { createId } from '../../utils/id.js'
import { hasPrivateBackups, savePrivateBackup } from './privateBackup.js'
import { errorSummary, logError, logInfo } from '../log.js'
import { openDB, type DBSchema, type IDBPDatabase } from 'idb'
import { toSessionSummary, type Message, type Session, type SessionSummary } from './types.js'

/** IndexedDB 存储结构版本；新增或调整存储、索引时递增。 */
export const DB_VERSION = 12

/** 文件原件按附件的本地 id 存储，所有引用同一 id 的消息共用一份；用于缩略图、打开查看，以及没有 serverId 时补传。 */
export type StoredFile = {
  id: string
  blob: Blob
}

/** 文件引用留在摘要中，删除会话时通过索引判断原件是否仍被引用。 */
type SessionRecord = Omit<Session, 'messages'> & { messages?: Message[]; revision?: string }
const sessionMetadata = (session: Session): SessionRecord => {
  const record: SessionRecord = { ...session }
  delete record.messages
  return record
}
type MessageRecord = { sessionId: string; position: number; message: Message }

type StoredSessionSummary = SessionSummary & { fileIds: string[] }

interface ChatDB extends DBSchema {
  /** 当前使用的会话，界面读写都在这里 */
  sessions: { key: string; value: SessionRecord }
  messages: { key: [string, number]; value: MessageRecord }
  sessionSummaries: {
    key: string
    value: StoredSessionSummary
    indexes: { fileIds: string }
  }
  /** 当前使用的文件原件 */
  files: { key: string; value: StoredFile }
  /**
   * 「全部删除」与整包原子替换走的暂存：写入这两个存储后在一个事务里替换正式数据。
   * 大型归档按会话和文件批次写暂存，最后才切换正式库。
   */
  sessionsStaging: { key: string; value: Session }
  filesStaging: { key: string; value: StoredFile }
}

let dbPromise: Promise<IDBPDatabase<ChatDB>> | null = null

const storedSummary = (session: Session): StoredSessionSummary => ({
  ...toSessionSummary(session),
  fileIds: [
    ...new Set(
      session.messages.flatMap((message) =>
        message.role === 'user' ? message.files.map((file) => file.id) : []
      )
    ),
  ],
})

const abortTransaction = (tx: { abort(): void }) => {
  try {
    tx.abort()
  } catch {
    // 事务已因请求失败中止。
  }
}

const messageRange = (id: string) => IDBKeyRange.bound([id, 0], [id, Number.MAX_SAFE_INTEGER])

// Only reuse cached message references if the transaction sees the same committed revision.
const writtenMessages = new Map<string, { revision: string; messages: Message[] }>()
const writeMessages = async (
  target: { delete(key: IDBKeyRange): Promise<void>; put(record: MessageRecord): Promise<unknown> },
  session: Session,
  previous?: Message[]
) => {
  if (!previous) {
    await target.delete(messageRange(session.id))
  }
  for (let position = 0; position < session.messages.length; position += 1) {
    const message = session.messages[position]
    if (previous?.[position] !== message) {
      await target.put({ sessionId: session.id, position, message })
    }
  }
  if (previous && previous.length > session.messages.length) {
    await target.delete(IDBKeyRange.bound([session.id, session.messages.length], [session.id, previous.length]))
  }
}

const backUpBeforeUpgrade = async () => {
  if (!hasPrivateBackups()) {
    return
  }
  let missing = false
  const existing = await openDB<ChatDB>('deepsleep', undefined, {
    upgrade(_db, _oldVersion, _version, tx) {
      missing = true
      void tx.done.catch(() => {})
      tx.abort()
    },
  }).catch((error: unknown) => {
    if (!missing) {
      throw error
    }
    return undefined
  })
  if (!existing) {
    return
  }
  const legacy = existing
  const version = legacy.version
  try {
    if (version >= DB_VERSION) {
      return
    }
    if (!legacy.objectStoreNames.contains('sessions') || !(await legacy.count('sessions'))) {
      return
    }
    const ids = await legacy.getAllKeys('sessions')
    const sessions = async function* () {
      for (const id of ids) {
        const value = await legacy.get('sessions', id)
        if (!value?.messages) {
          throw new Error('MIGRATION_BACKUP_SESSION_MISSING')
        }
        yield { ...value, messages: value.messages }
      }
    }
    const { exportArchiveTo } = await import('./history/exportArchive.js')
    const file = async (id: string) => (await legacy.get('files', id))?.blob
    await savePrivateBackup((sink) => exportArchiveTo({
      sessions: sessions(), file, localSnapshot: true,
    }, sink))
    logInfo('storage', '消息表迁移前快照已提交', { sessionCount: ids.length, version })
  } finally {
    legacy.close()
  }
}

const getDB = () =>
  (dbPromise ??= backUpBeforeUpgrade().then(() => openDB<ChatDB>('deepsleep', DB_VERSION, {
    upgrade(db, oldVersion, _newVersion, tx) {
      // The open request reports an aborted upgrade; consume the transaction rejection too.
      void tx.done.catch(() => {})
      for (const name of ['sessions', 'files', 'sessionsStaging', 'filesStaging'] as const) {
        if (!db.objectStoreNames.contains(name)) {
          db.createObjectStore(name, { keyPath: 'id' })
        }
      }
      const summaries = db.objectStoreNames.contains('sessionSummaries')
        ? tx.objectStore('sessionSummaries')
        : db.createObjectStore('sessionSummaries', { keyPath: 'id' })
      if (!summaries.indexNames.contains('fileIds')) {
        summaries.createIndex('fileIds', 'fileIds', { multiEntry: true })
      }
      if (oldVersion < 12) {
        const messages = db.createObjectStore('messages', { keyPath: ['sessionId', 'position'] })
        if (oldVersion !== 0) {
          void (async () => {
            for (let cursor = await tx.objectStore('sessions').openCursor(); cursor; cursor = await cursor.continue()) {
              const { messages: original, ...meta } = cursor.value
              if (!Array.isArray(original)) {
                throw new Error('MIGRATION_INVALID_SESSION')
              }
              for (let position = 0; position < original.length; position += 1) {
                await messages.put({ sessionId: meta.id, position, message: original[position] })
              }
              await cursor.update(meta)
            }
          })().catch(() => abortTransaction(tx))
        }
      }
    },
    blocking(_currentVersion, _blockedVersion, event) {
      const connection = event.target
      if (connection instanceof IDBDatabase) {
        connection.close()
        dbPromise = null
      }
    },
  })).catch((error: unknown) => {
    dbPromise = null
    throw error
  }))

export const countSavedSessions = async (): Promise<number> => (await getDB()).count('sessionSummaries')

export const loadSessionSummaries = async (): Promise<SessionSummary[]> => {
  const db = await getDB()
  const available = await db.getAll('sessionSummaries')
  if (available.length > 0) {
    return available.map(toSessionSummary)
  }
  const tx = db.transaction(['sessionSummaries', 'sessions', 'messages'], 'readwrite')
  const restored = await Promise.all([
    (async () => {
      const summaries = tx.objectStore('sessionSummaries')
      try {
        const existing = await summaries.getAll()
        if (existing.length > 0) {
          return existing
        }
        const rebuilt: StoredSessionSummary[] = []
        for (let cursor = await tx.objectStore('sessions').openCursor(); cursor; cursor = await cursor.continue()) {
          const rows = await tx.objectStore('messages').getAll(messageRange(cursor.value.id))
          const summary = storedSummary({ ...cursor.value, messages: rows.map(({ message }) => message) })
          await summaries.put(summary)
          rebuilt.push(summary)
        }
        return rebuilt
      } catch (error) {
        abortTransaction(tx)
        throw error
      }
    })(),
    tx.done,
  ])
  logInfo('storage', restored[0].length > 0 ? '已从会话正文重建空摘要索引' : '摘要与会话正文均为空', {
    sessionCount: restored[0].length,
  })
  return restored[0].map(toSessionSummary)
}

export const loadSession = async (id: string): Promise<Session | undefined> => {
  const tx = (await getDB()).transaction(['sessions', 'messages'])
  const [session, rows] = await Promise.all([
    tx.objectStore('sessions').get(id),
    tx.objectStore('messages').getAll(messageRange(id)),
    tx.done,
  ])
  if (!session) {
    return undefined
  }
  const meta = { ...session }
  delete meta.revision
  return { ...meta, messages: rows.map(({ message }) => message) }
}

export const saveSession = async (session: Session, files: StoredFile[] = []): Promise<void> => {
  const summary = storedSummary(session)
  const db = await getDB()
  const revision = createId()
  const tx = db.transaction(['sessions', 'sessionSummaries', 'files', 'messages'], 'readwrite')
  await Promise.all([
    (async () => {
      try {
        const sessions = tx.objectStore('sessions')
        const prior = await sessions.get(session.id)
        const cached = writtenMessages.get(session.id)
        const previous = cached && cached.revision === prior?.revision ? cached.messages : undefined
        for (const file of files) {
          await tx.objectStore('files').put(file)
        }
        await writeMessages(tx.objectStore('messages'), session, previous)
        await sessions.put({ ...sessionMetadata(session), revision })
        await tx.objectStore('sessionSummaries').put(summary)
      } catch (error) {
        abortTransaction(tx)
        throw error
      }
    })(),
    tx.done,
  ])
  writtenMessages.set(session.id, { revision, messages: session.messages })
  if (writtenMessages.size > 16) {
    const oldest = writtenMessages.keys().next().value
    if (oldest !== undefined) {
      writtenMessages.delete(oldest)
    }
  }
}

/** 未打开的会话也可重命名，只读取该会话，原子更新详情和列表。 */
export const renameSession = async (id: string, title: string): Promise<void> => {
  const tx = (await getDB()).transaction(['sessions', 'sessionSummaries'], 'readwrite')
  await Promise.all([
    (async () => {
      try {
        const sessions = tx.objectStore('sessions')
        const session = await sessions.get(id)
        if (session) {
          session.title = title
          await sessions.put(session)
          const summary = await tx.objectStore('sessionSummaries').get(id)
          if (summary) {
            await tx.objectStore('sessionSummaries').put({ ...summary, title })
          }
        }
      } catch (error) {
        abortTransaction(tx)
        throw error
      }
    })(),
    tx.done,
  ])
}

/** 删除会话，仅清理已无会话引用的本地原件；远端文件不删。 */
export const deleteSession = async (sessionId: string): Promise<void> => {
  const tx = (await getDB()).transaction(['sessions', 'sessionSummaries', 'files', 'messages'], 'readwrite')
  await Promise.all([
    (async () => {
      try {
        const summaries = tx.objectStore('sessionSummaries')
        const summary = await summaries.get(sessionId)
        await tx.objectStore('sessions').delete(sessionId)
        await tx.objectStore('messages').delete(messageRange(sessionId))
        await summaries.delete(sessionId)
        for (const id of summary?.fileIds ?? []) {
          if ((await summaries.index('fileIds').count(id)) === 0) {
            await tx.objectStore('files').delete(id)
          }
        }
      } catch (error) {
        abortTransaction(tx)
        throw error
      }
    })(),
    tx.done,
  ])
  writtenMessages.delete(sessionId)
}

const putFiles = async (store: 'files' | 'filesStaging', files: StoredFile[]) => {
  const tx = (await getDB()).transaction(store, 'readwrite')
  await Promise.all([...files.map((file) => tx.store.put(file)), tx.done])
}

export const saveFiles = (files: StoredFile[]): Promise<void> => putFiles('files', files)

export const loadFile = async (id: string): Promise<Blob | undefined> =>
  (await (await getDB()).get('files', id))?.blob

/** 清空导入暂存：开始导入前清除上次中断（如关闭页面）遗留的数据，导入失败后清除本次写入。 */
export const clearStaging = async (): Promise<void> => {
  const tx = (await getDB()).transaction(['sessionsStaging', 'filesStaging'], 'readwrite')
  await Promise.all([
    tx.objectStore('sessionsStaging').clear(),
    tx.objectStore('filesStaging').clear(),
    tx.done,
  ])
}

export const addStagingSession = async (session: Session): Promise<void> => {
  await (await getDB()).add('sessionsStaging', session)
}

export const saveStagingFiles = (files: StoredFile[]): Promise<void> =>
  putFiles('filesStaging', files)

/**
 * 导入完成后用暂存替换正式数据：同一事务中替换会话、摘要和原件，并清空暂存。
 * 逐条游标复制，同一时间只读取一条记录；事务失败时整体回滚，正式数据不变。
 */
export const commitStaging = async (): Promise<SessionSummary[]> => {
  logInfo('storage', '开始提交历史暂存')
  const summaries: SessionSummary[] = []
  const tx = (await getDB()).transaction(
    ['sessions', 'sessionSummaries', 'files', 'sessionsStaging', 'filesStaging', 'messages'],
    'readwrite'
  )
  const move = async (from: 'sessionsStaging' | 'filesStaging', to: 'sessions' | 'files') => {
    try {
      const target = tx.objectStore(to)
      await target.clear()
      if (to === 'sessions') {
        await tx.objectStore('sessionSummaries').clear()
        await tx.objectStore('messages').clear()
      }
      for (
        let cursor = await tx.objectStore(from).openCursor();
        cursor;
        cursor = await cursor.continue()
      ) {
        if (to === 'sessions') {
          const session = cursor.value as Session
          await tx.objectStore('sessions').put(sessionMetadata(session))
          await writeMessages(tx.objectStore('messages'), session)
          const summary = storedSummary(session)
          await tx.objectStore('sessionSummaries').put(summary)
          summaries.push(toSessionSummary(summary))
        } else {
          await tx.objectStore('files').put(cursor.value as StoredFile)
        }
      }
      await tx.objectStore(from).clear()
    } catch (error) {
      // 同步抛出的错误不会让事务自动回滚，需显式中止，避免只提交清空和部分移入。
      abortTransaction(tx)
      throw error
    }
  }
  await Promise.all([move('sessionsStaging', 'sessions'), move('filesStaging', 'files'), tx.done])
  // 直接返回本次提交的列表，调用方无需在替换成功后再发起可能失败的读取。
  writtenMessages.clear()
  logInfo('storage', '历史暂存已提交', { sessions: summaries.length })
  return summaries
}

/** 一次事务里写的原件个数：几十 MB 的图片塞进同一个事务会拖长整个事务，也更容易失败。 */
const FILE_BATCH = 8

/** 保持文件批次有界。中断只留下暂存记录，正式历史仍可读。 */
export const putHistorySession = async (
  session: Session,
  files: readonly StoredFile[]
): Promise<void> => {
  for (let at = 0; at < files.length; at += FILE_BATCH) {
    await putFiles('filesStaging', files.slice(at, at + FILE_BATCH))
  }
  await addStagingSession(session)
}

export const reportStorageError = (action: string) => (error: unknown) => {
  logError('storage', '存储操作失败', { action, reason: errorSummary(error) })
}
