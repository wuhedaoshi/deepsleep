import assert from 'node:assert/strict'
import 'fake-indexeddb/auto'
globalThis.__API_ORIGIN__ = 'http://storage.invalid'
globalThis.window = globalThis
globalThis.document = { visibilityState: 'visible', addEventListener() {}, removeEventListener() {} }
globalThis.requestAnimationFrame = (callback) => setTimeout(() => callback(0), 0)
globalThis.cancelAnimationFrame = clearTimeout
const db = await import('../src/services/chat/db.ts')
const store = await import('../src/services/chat/store.ts')
const { getLogEntries } = await import('../src/services/log.ts')
const { inspectStorage } = await import('../src/services/chat/storageWatermark.ts')
const session = (id, messages=[]) => ({id,title:id,createdAt:1,updatedAt:2,messages,rootMessageId:null})
await db.saveSession(session('old'),[{id:'old-file',blob:new Blob(['original'])}])
await db.clearStaging()
await db.putHistorySession(session('new'),[{id:'new-file',blob:new Blob(['new'])}])
assert.equal((await db.loadSessionSummaries())[0].id,'old')
assert.equal(await db.loadSession('new'),undefined)
assert.equal(await db.loadFile('new-file'),undefined)
await db.clearStaging()
assert.equal(await (await db.loadFile('old-file')).text(),'original')
await db.putHistorySession(session('invalid',[{role:'user'}]),[])
await assert.rejects(db.commitStaging())
assert.equal((await db.loadSessionSummaries())[0].id,'old')
assert.equal(await (await db.loadFile('old-file')).text(),'original')
await db.clearStaging()
await db.putHistorySession(session('new'),[{id:'new-file',blob:new Blob(['new'])}])
assert.deepEqual((await db.commitStaging()).map(s=>s.id),['new'])
assert.equal(await db.loadSession('old'),undefined)
assert.equal(await (await db.loadFile('new-file')).text(),'new')
console.log('PASS staged interruption, transaction rollback and complete replacement')
await store.initChat()
store.useChatStore.setState(state=>({sessionCache:{...state.sessionCache,new:session('new')}}))
const put=IDBObjectStore.prototype.put
let failures=0
IDBObjectStore.prototype.put=function(value,...args){
  if(this.name==='sessions' && value.title==='renamed' && failures<2){
    failures++
    throw new DOMException('raw content must not be logged', 'AbortError')
  }
  return put.call(this,value,...args)
}
try {
  store.renameSession('new','renamed')
  for(let i=0;i<100 && (await db.loadSession('new')).title!=='renamed';i++){
    await new Promise(r=>setTimeout(r,25))
  }
  assert.equal(failures,2)
  assert.equal((await db.loadSession('new')).title,'renamed')
  const logs=JSON.stringify(getLogEntries())
  assert(logs.includes('会话保存将重试'))
  assert(!logs.includes('raw content must not be logged'))
} finally {
  IDBObjectStore.prototype.put=put
}
globalThis.__deepsleepNative={readStorageWatermark:()=>JSON.stringify({count:3,port:8731,action:'save'})}
globalThis.location={port:'8731'}
assert.equal(inspectStorage(0),true)
assert.equal(inspectStorage(3),false)
globalThis.location.port='8732'
assert.equal(inspectStorage(3),true)
console.log('PASS save retry, redacted logging and native watermark checks')

await assert.rejects(store.replaceHistoryProgressively(async () => {
  await db.putHistorySession(session('partial'), [])
  throw new Error('simulated interrupted import')
}))
assert.equal(await db.loadSession('partial'), undefined)
assert.equal((await db.loadSession('new')).title, 'renamed')
let failedOnce = false
IDBObjectStore.prototype.put = function(value, ...args) {
  if (this.name === 'sessions' && value.title === 'pending deletion') {
    failedOnce = true
    throw new DOMException('interrupted write', 'AbortError')
  }
  return put.call(this, value, ...args)
}
try {
  store.renameSession('new', 'pending deletion')
  for (let i = 0; !failedOnce && i < 30; i++) {
    await new Promise(r => setTimeout(r, 5))
  }
  assert(failedOnce)
  assert.equal(await store.removeSession('new'), true)
  await new Promise(r => setTimeout(r, 250))
  assert.equal(await db.loadSession('new'), undefined)
} finally {
  IDBObjectStore.prototype.put = put
}
console.log('PASS interrupted import through store and deletion fencing for retries')

await db.saveSession(session('recoverable'), [{id:'survivor',blob:new Blob(['saved'])}])
const raw = await new Promise((resolve, reject) => {
  const request = indexedDB.open('deepsleep')
  request.onsuccess = () => resolve(request.result)
  request.onerror = () => reject(request.error)
})
await new Promise((resolve, reject) => {
  const tx = raw.transaction('sessionSummaries', 'readwrite')
  tx.objectStore('sessionSummaries').clear()
  tx.oncomplete = () => resolve()
  tx.onerror = () => reject(tx.error)
})
raw.close()
assert.deepEqual((await db.loadSessionSummaries()).map(s=>s.id), ['recoverable'])
assert.equal(await (await db.loadFile('survivor')).text(), 'saved')
console.log('PASS recovering an empty summary index preserves sessions and files')
