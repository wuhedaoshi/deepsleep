// 运行时核对：自动压缩请求的「信封」是否真的丢了 system / thinking / search / tools。
//
// 用法（frontend 下）：
//   node --experimental-transform-types --import ./tools/run-ts.mjs tools/envelope-check.mjs
//
// 做法：真 store + 真 compaction + fake-indexeddb + 进程内假 fetch（不联网）。
// 先从 store 走一遍「自动压缩 → 正式请求」，再把两条请求的 system / model / thinking /
// tools / safety_check 逐项对比：相等就说明运行时没有丢失，只是靠 compaction 的默认回退补上的。
// 最后直接调 buildCompactionRequest 证明「显式传 system 时确实会被采用」——即改造人设时必须透传。
globalThis.__API_ORIGIN__ = 'http://envelope.invalid'
const memoryStore = new Map()
globalThis.localStorage = {
  getItem: (key) => (memoryStore.has(key) ? memoryStore.get(key) : null),
  setItem: (key, value) => memoryStore.set(key, String(value)),
  removeItem: (key) => memoryStore.delete(key),
  clear: () => memoryStore.clear(),
}
globalThis.requestAnimationFrame = (callback) => setTimeout(() => callback(0), 0)
globalThis.cancelAnimationFrame = (id) => clearTimeout(id)
globalThis.document = {
  visibilityState: 'visible',
  addEventListener() {},
  removeEventListener() {},
}
globalThis.window = globalThis

import 'fake-indexeddb/auto'
import assert from 'node:assert/strict'

const { initChat, sendMessage, useChatStore } = await import('../src/services/chat/store.ts')
const { getDraft, setDraftText } = await import('../src/services/chat/drafts.ts')
const { useSettings } = await import('../src/services/settings.ts')
const { buildCompactionRequest, compactSession, COMPACTION_INSTRUCTION } =
  await import('../src/services/chat/compaction.ts')
const db = await import('../src/services/chat/db.ts')

// ---- 假模型：记录每个请求的信封，并按需返回流式回答 ---------------------------
const records = []
const summaryText =
  '## 主要请求与意图\n- 验证压缩请求信封。\n## 关键技术概念\n- 前后缀一致。\n' +
  '## 文件与代码\n- frontend/src/services/chat/compaction.ts\n## 错误与修复\n- （无）\n' +
  '## 未完成的工作\n- （无）\n## 当前进度\n- 正在验证。\n## 下一步\n- 继续。\n## 关键上下文\n- 无。'
const usage = {
  input_tokens: 900_000,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
  output_tokens: 10,
}
const encoder = new TextEncoder()
globalThis.fetch = async (_url, init) => {
  const body = JSON.parse(init.body)
  const lastMessage = body.messages.at(-1)
  const isCompaction = JSON.stringify(lastMessage).includes('压缩引擎')
  records.push({ body, isCompaction })
  const text = isCompaction ? summaryText : '正常回答'
  const events = [
    { type: 'message_start', message: { id: `msg_${records.length}`, usage } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage },
    { type: 'message_stop' },
  ]
  const payload = events
    .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    .join('')
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(payload))
      controller.close()
    },
  })
  return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
}

useSettings.setState({ apiKey: 'sk-mock', model: 'deepseek-flash', thinking: true, search: true })
await initChat()

const waitIdle = async (sessionId) => {
  for (let i = 0; i < 400; i += 1) {
    if (useChatStore.getState().streaming[sessionId] === undefined) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error('发送没有在 8s 内结束')
}

// 攒够 3 轮：压缩要留一条逐字保留的尾巴，只有一轮时「没有可压区间」是正确行为。
setDraftText(null, '第 1 条消息')
sendMessage(null)
const sessionId = useChatStore.getState().activeId
await waitIdle(sessionId)
for (const text of ['第 2 条消息', '第 3 条消息']) {
  setDraftText(sessionId, text)
  sendMessage(sessionId)
  await waitIdle(sessionId)
}

// 把前三轮撑大，让保留预算之外真的存在可压区间（真实长会话里的常态）。
const stored = await db.loadSession(sessionId)
stored.messages
  .filter((message) => message.role === 'user')
  .forEach((message) => {
    message.content = 'A'.repeat(300_000)
  })
await db.saveSession(stored)
useChatStore.setState((state) => ({ sessionCache: { ...state.sessionCache, [sessionId]: stored } }))

// 第 4 次发送：usage 已过阈值 → 先发压缩请求，再发正式请求。
records.length = 0
setDraftText(sessionId, '第 4 条消息')
sendMessage(sessionId)
await waitIdle(sessionId)

const compactionRecord = records.find((record) => record.isCompaction)
const chatRecord = [...records].reverse().find((record) => !record.isCompaction)
assert.ok(compactionRecord, `没有发出压缩请求：${records.map((r) => r.isCompaction).join(',')}`)
assert.ok(chatRecord, '没有发出正式请求')
assert.equal(records[0].isCompaction, true, '压缩必须先于正式请求')

const envelopeOf = (body) => ({
  model: body.model,
  system: body.system,
  thinking: body.thinking,
  tools: body.tools,
  safety_check: body.safety_check,
})
const compactionEnvelope = envelopeOf(compactionRecord.body)
const chatEnvelope = envelopeOf(chatRecord.body)

assert.deepEqual(compactionEnvelope, chatEnvelope)
assert.ok(!JSON.stringify(chatRecord.body).includes(COMPACTION_INSTRUCTION.slice(0, 20)))
console.log('PASS 1 自动压缩请求与正式请求的信封逐项相等（运行时没有丢失）')
console.log(`  实际值：${JSON.stringify(compactionEnvelope)}`)

// store 两个调用点都只传了 model 与 policy.window；system/thinking/search 靠 compaction 回退。
const session = await db.loadSession(sessionId)
const lastReply = session.messages.filter((m) => m.role === 'assistant').at(-1)
assert.equal(compactionEnvelope.system, '该助手为DeepSeek，由深度求索公司创造。')
assert.deepEqual(compactionEnvelope.thinking, { type: 'enabled' })
assert.equal(
  compactionEnvelope.tools.some((tool) => tool.name === 'deepseek_web_search'),
  true
)
console.log(
  `PASS 2 回退来源：system=DEFAULT_SYSTEM_PROMPT（与 store 逐字一致），` +
    `thinking/search 取自末轮回答（thinking=${lastReply.thinking}, search=${lastReply.search}）`
)

// 显式传 system 时确实生效 —— 即「将来加自定义人设必须透传 envelope」，本次不改。
const { getContextRounds } = await import('../src/services/chat/reply.ts')
const { selectCompactionRange, getRetainTokens, COMPACTION_POLICY } =
  await import('../src/services/chat/compaction.ts')
const rounds = getContextRounds(session.messages)
const range = selectCompactionRange(rounds, getRetainTokens(COMPACTION_POLICY.window))
assert.ok(range, '应当存在可压区间')
const customSystem = '你是一位自定义人设'
const custom = buildCompactionRequest(range, {
  model: 'deepseek-flash',
  system: customSystem,
  thinking: false,
  search: false,
})
assert.equal(custom.system, customSystem)
assert.deepEqual(custom.thinking, { type: 'disabled' })
assert.equal(custom.tools.length, 1)
console.log(
  'PASS 3 显式 envelope 生效：system/thinking/search 传什么就是什么（透传是改造人设的前置条件）'
)

// 已知限制：开关在「末轮回答之后、再次发送之前」被改掉时，压缩请求仍按末轮回答的取值组装，
// 与正式请求的前缀不同 → 前缀缓存命不中（不是本次的 envelope 丢失，属于缓存命中问题）。
// 这里用压缩前的那份会话（3 轮、无 checkpoint）复现：否则已压过的会话只剩一轮，没有可压区间。
useSettings.setState({ thinking: false })
records.length = 0
await compactSession(stored, 'sk-mock', undefined, {
  envelope: { model: 'deepseek-flash', policy: { window: COMPACTION_POLICY.window } },
})
const toggled = records.find((record) => record.isCompaction)
assert.deepEqual(toggled.body.thinking, { type: 'enabled' })
console.log(
  'PASS 4 记录限制：关掉思考后再压缩，仍沿用末轮回答的 thinking=enabled（前缀与主请求不一致）'
)

console.log(
  '结论：运行时没有 envelope 丢失，本次不动 compaction；改造人设时必须同时透传 system/thinking/search'
)
