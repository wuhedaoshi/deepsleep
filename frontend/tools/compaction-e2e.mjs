// 端到端验证压缩链路：真 store + 真 compaction + 假浏览器（fake-indexeddb）+ 本地 mock 服务。
//
// 步骤：发一条消息（mock 回 usage=900k）→ 把这条轮次撑大到远超保留预算 →
// 再发一条 → 断言：
//   1. 第二次发送前先发了一次「压缩请求」（最后一条 user 是压缩指令）；
//   2. 压缩结果写进 session.compaction；
//   3. 正式请求第一条是 checkpoint（含前导与 <compacted-summary>），最后一条是本轮提问。
//
// 用法（frontend 下，先启动 mock）：
//   node --experimental-transform-types --import ./tools/run-ts.mjs tools/compaction-e2e.mjs
globalThis.__API_ORIGIN__ = 'http://127.0.0.1:8099'
// 浏览器环境的最小替身：store 用 rAF 与 document.visibilityState，settings 用 localStorage。
const memoryStore = new Map()
globalThis.localStorage = {
  getItem: (key) => (memoryStore.has(key) ? memoryStore.get(key) : null),
  setItem: (key, value) => memoryStore.set(key, String(value)),
  removeItem: (key) => memoryStore.delete(key),
  clear: () => memoryStore.clear(),
}
globalThis.requestAnimationFrame = (callback) => setTimeout(() => callback(0), 0)
globalThis.cancelAnimationFrame = (id) => clearTimeout(id)
globalThis.document = { visibilityState: 'visible', addEventListener() {}, removeEventListener() {} }
globalThis.window = globalThis

import 'fake-indexeddb/auto'
import { readFileSync } from 'node:fs'

const db = await import('../src/services/chat/db.ts')
const { initChat, sendMessage, useChatStore } = await import('../src/services/chat/store.ts')
const { getDraft, setDraftText } = await import('../src/services/chat/drafts.ts')
const { useSettings } = await import('../src/services/settings.ts')

useSettings.setState({ apiKey: 'sk-mock', model: 'deepseek-flash' })
await initChat()

const waitIdle = async (sessionId) => {
  for (let i = 0; i < 400; i += 1) {
    if (useChatStore.getState().streaming[sessionId] === undefined) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error('发送没有在 20s 内结束')
}

// 先攒 3 轮：压缩必须留一条逐字保留的尾巴，只有一轮时「没有可压区间」是正确行为。
setDraftText(null, '第 1 条消息')
sendMessage(null)
const sessionId = useChatStore.getState().activeId
await waitIdle(sessionId)
for (const text of ['第 2 条消息', '第 3 条消息']) {
  setDraftText(sessionId, text)
  sendMessage(sessionId)
  await waitIdle(sessionId)
}

// 把这一轮撑大：压缩的范围选择按估算 token 算保留区，轮次太小就「没有可压的历史」
// ——这是正确行为（DSH 同样只在存在平衡区间时才压），所以测试里制造一段超预算的历史。
const stored = await db.loadSession(sessionId)
stored.messages
  .filter((message) => message.role === 'user')
  .slice(0, 2)
  .forEach((message) => {
    message.content = 'A'.repeat(800_000)
  })
await db.saveSession(stored)
useChatStore.setState((state) => ({
  sessionCache: { ...state.sessionCache, [sessionId]: stored },
}))
// 诊断：把判定输入直接打出来（这轮如果没触发压缩，就看这里）。
const { getContextRounds } = await import('../src/services/chat/reply.ts')
const compactionMod = await import('../src/services/chat/compaction.ts')
const rounds = getContextRounds(stored.messages)
const lastReply = rounds.at(-1)?.[1]
console.log(
  `诊断：轮次 ${rounds.length}，末轮 usage=${JSON.stringify(lastReply?.usage)}，` +
    `窗口 ${compactionMod.contextWindowFor('deepseek-flash')}，` +
    `阈值 ${compactionMod.getThresholdTokens(compactionMod.contextWindowFor('deepseek-flash'))}，` +
    `shouldCompact=${lastReply?.usage ? compactionMod.shouldCompact(lastReply.usage, compactionMod.contextWindowFor('deepseek-flash')) : 'no-usage'}，` +
    `可压区间=${compactionMod.selectCompactionRange(rounds, compactionMod.getRetainTokens(compactionMod.contextWindowFor('deepseek-flash'))) === null ? 'null' : 'ok'}`
)

// 第二轮：应当先压缩，再发正式请求。
setDraftText(sessionId, '第 4 条消息')
sendMessage(sessionId)
await waitIdle(sessionId)

const records = readFileSync(process.env.MOCK_LOG ?? 'requests.jsonl', 'utf8')
  .trim()
  .split('\n')
  .map((line) => JSON.parse(line))
const session = await db.loadSession(sessionId)
const compaction = session?.compaction
const mainRequest = [...records].reverse().find((record) => record.kind === 'chat')

const checks = [
  ['前 5 次请求就是 3 轮 + 压缩 + 正式', records.slice(0, 5).map((record) => record.kind).join(',') === 'chat,chat,chat,compaction,chat'],
  ['正式请求之前先发了压缩请求', records[3]?.kind === 'compaction'],
  ['session.compaction 已落盘', compaction !== undefined],
  ['正式请求首条是 checkpoint', mainRequest?.firstStartsWithCheckpoint === true],
  ['正式请求最后一条是本轮提问', mainRequest?.lastRole === 'user'],
]
for (const [name, ok] of checks) {
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}`)
}
console.log(`请求序列：${records.map((record) => record.kind).join(' → ')}`)
if (compaction !== undefined) {
  console.log(
    `摘要 ${compaction.summary.length} 字，锚点 ${compaction.upToMessageId.slice(0, 8)}，释放 ${compaction.savedTokens} tokens`
  )
}
// ---- 手动压缩 ----------------------------------------------------------------
// 手动路径要验两件事：/compact 指令被拦截成命令（不进对话），以及「有可压区间」时能压成功。
const { compactNow } = await import('../src/services/chat/store.ts')

setDraftText(null, '手测一')
sendMessage(null)
const manualId = useChatStore.getState().activeId
await waitIdle(manualId)
for (const text of ['手测二', '手测三']) {
  setDraftText(manualId, text)
  sendMessage(manualId)
  await waitIdle(manualId)
}

// 1) 历史太短：应当明确回报「没有可压缩的历史」，且不发压缩请求。
const shortOutcome = await compactNow(manualId)

// 2) 撑大前两轮再走 /compact 指令：应当真的压成功。
const target = await db.loadSession(manualId)
target.messages
  .filter((message) => message.role === 'user')
  .slice(0, 2)
  .forEach((message) => {
    message.content = 'B'.repeat(800_000)
  })
await db.saveSession(target)
useChatStore.setState((state) => ({
  sessionCache: { ...state.sessionCache, [manualId]: target },
}))
const draftBefore = 'x'
setDraftText(manualId, '/compact')
sendMessage(manualId)
await new Promise((resolve) => setTimeout(resolve, 1500))
const afterCommand = await db.loadSession(manualId)
const draftAfter = getDraft(manualId).text

const manualChecks = [
  ['短历史手动压缩回报 nothing', shortOutcome === 'nothing'],
  ['/compact 后草稿被清空（没当成提问发出去）', draftAfter === ''],
  ['/compact 真的压出了 checkpoint', afterCommand?.compaction !== undefined],
]
for (const [name, ok] of manualChecks) {
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}`)
}
process.exitCode =
  checks.every(([, ok]) => ok) && manualChecks.every(([, ok]) => ok) ? 0 : 1
void draftBefore
