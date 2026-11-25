import assert from 'node:assert/strict'
import 'fake-indexeddb/auto'
import { openDB } from 'idb'

globalThis.__API_ORIGIN__ = 'http://backup.invalid'
globalThis.window = globalThis
globalThis.location = { port: '8731' }
globalThis.document = { visibilityState: 'visible', addEventListener() {}, removeEventListener() {} }
globalThis.requestAnimationFrame = (callback) => setTimeout(() => callback(0), 0)
globalThis.cancelAnimationFrame = clearTimeout

const output = []
const archiveName = 'auto-' + Date.now() + '.zip'
let archive
let failWrite = true
globalThis.__deepsleepNative = {
  beginPrivateBackup() { output.length = 0; return true },
  appendPrivateBackup(encoded) {
    if (failWrite) return false
    output.push(Buffer.from(encoded, 'base64'))
    return true
  },
  abortPrivateBackup() { output.length = 0 },
  finishPrivateBackup() { archive = Buffer.concat(output); return true },
  listPrivateBackups: () => archive ? archiveName + ':' + archive.length : '',
  readPrivateBackup: (_name, start, length) => archive.subarray(start, start + length).toString('base64'),
}

const date = 1700000000000
const attachment = 'test-attachment-bytes'
const message = {
  id: 'msg-1', role: 'user', content: 'original content', files: [
    { id: 'file_1', name: 'test.txt', size: attachment.length, mimeType: 'text/plain' },
  ],
  createdAt: date, parentId: null, selectedChildId: 'reply-2',
}
const reply = {
  id: 'reply-1', role: 'assistant', blocks: [{ type: 'text', text: 'reply' }],
  createdAt: date + 1, parentId: 'msg-1', selectedChildId: null, status: 'done',
}
const alternate = {
  ...reply, id: 'reply-2', createdAt: date + 2,
  blocks: [{ type: 'text', text: 'alternate reply' }],
}
const original = {
  id: 'test-archive', title: 'old', createdAt: date, updatedAt: date + 2,
  rootMessageId: 'msg-1', messages: [message, reply, alternate], pinned: true,
  compaction: { upToMessageId: 'reply-1', summary: 'checkpoint', createdAt: date + 3, savedTokens: 9 },
}
const previous = await openDB('deepsleep', 11, {
  upgrade(db) {
    for (const name of ['sessions', 'files', 'sessionsStaging', 'filesStaging']) {
      db.createObjectStore(name, { keyPath: 'id' })
    }
    db.createObjectStore('sessionSummaries', { keyPath: 'id' }).createIndex('fileIds', 'fileIds', { multiEntry: true })
  },
})
await previous.put('sessions', original)
await previous.put('files', { id: 'file_1', blob: new Blob([attachment], { type: 'text/plain' }) })
await previous.put('sessionSummaries', {
  id: original.id, title: original.title, createdAt: date, updatedAt: date + 2, fileIds: ['file_1'], pinned: true,
})
previous.close()

const settings = await import('../src/services/settings.ts')
const supportsProviders = typeof settings.saveCustomProvider === 'function'
if (supportsProviders) {
  assert(settings.saveCustomProvider({
    id: 'custom:test', name: 'gateway', kind: 'chat', base: 'https://example.com/v1', key: 'fake-secret-token',
  }))
}

const db = await import('../src/services/chat/db.ts')
await assert.rejects(db.loadSession(original.id), /PRIVATE_BACKUP_WRITE_FAILED/)
assert.equal((await indexedDB.databases()).find(({ name }) => name === 'deepsleep').version, 11)
assert.equal(archive, undefined)
failWrite = false

const put = IDBObjectStore.prototype.put
IDBObjectStore.prototype.put = function (value, ...rest) {
  if (this.name === 'messages' && value.position === 1) throw new Error('simulated interruption')
  return put.call(this, value, ...rest)
}
try {
  await assert.rejects(db.loadSession(original.id), { name: 'AbortError' })
} finally {
  IDBObjectStore.prototype.put = put
}
const rolledBack = await openDB('deepsleep')
assert.equal(rolledBack.version, 11)
assert.deepEqual(await rolledBack.get('sessions', original.id), original)
rolledBack.close()

assert.deepEqual(await db.loadSession(original.id), original)
assert.equal(await (await db.loadFile('file_1')).text(), attachment)
const separate = await openDB('deepsleep')
assert.equal(separate.version, 12)
assert.equal((await separate.get('sessions', original.id)).messages, undefined)
assert.equal(await separate.count('messages'), 3)
separate.close()

const { openPrivateBackup } = await import('../src/services/chat/privateBackup.ts')
assert(archive.length > 0)
if (supportsProviders) {
  const { openHistoryArchive } = await import('../src/services/chat/history/archive.ts')
  const snapshot = await (await openHistoryArchive(openPrivateBackup())).providerSnapshot()
  assert.equal(snapshot.providers[0].name, 'gateway')
  assert(!JSON.stringify(snapshot).includes('fake-secret-token'))
}

const backups = await import('../src/services/chat/backup.ts')
const store = await import('../src/services/chat/store.ts')
await store.initChat()
const position = archive.indexOf(attachment)
assert(position >= 0, 'attachment entry should be stored directly')
archive[position] ^= 1
await assert.rejects(backups.restorePrivateBackup(archiveName))
assert.deepEqual(await db.loadSession(original.id), original)
assert.equal(await (await db.loadFile('file_1')).text(), attachment)
archive[position] ^= 1

await backups.clearHistory()
assert.equal((await db.loadSessionSummaries()).length, 0)
assert.equal((await backups.restorePrivateBackup(archiveName)).imported, 1)
assert.deepEqual(await db.loadSession(original.id), original)
assert.equal(await (await db.loadFile('file_1')).text(), attachment)
console.log('PASS backup gate, transactional migration rollback, native restore, CRC failure and exact data roundtrip')
