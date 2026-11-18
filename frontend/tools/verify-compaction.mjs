// 本地验收不访问真实 API，避免测试摘要消耗额度或修改用户会话。
// node --experimental-transform-types --import ./tools/run-ts.mjs tools/verify-compaction.mjs
import assert from 'node:assert/strict'
import 'fake-indexeddb/auto'

globalThis.__API_ORIGIN__ = 'http://compaction.invalid'
globalThis.window = globalThis
globalThis.document = { visibilityState: 'visible', addEventListener() {}, removeEventListener() {} }
globalThis.requestAnimationFrame = (callback) => setTimeout(() => callback(0), 0)
globalThis.cancelAnimationFrame = clearTimeout
const storage = new Map()
globalThis.localStorage = {
  getItem: (key) => storage.get(key) ?? null,
  setItem: (key, value) => storage.set(key, String(value)),
  removeItem: (key) => storage.delete(key),
}
const {
  COMPACTION_POLICY, DEFAULT_MODEL, compactSession, evaluateCompaction,
  estimateRoundsTokens, estimateTextTokens, getThresholdTokens, resolveWindow, shouldCompact,
} = await import('../src/services/chat/compaction.ts')
const { readMessageEvent } = await import('../src/services/api/parseEvent.ts')
const { frameCheckpoint, getContextRounds, toRequestMessages } = await import('../src/services/chat/reply.ts')
const { getLogEntries, clearLog } = await import('../src/services/log.ts')
const { setContextWindowOverride, useSettings } = await import('../src/services/settings.ts')
const usage = (pressure) => ({ input_tokens: pressure - 3, cache_creation_input_tokens: 1, cache_read_input_tokens: 1, output_tokens: 1 })
const round = (id, textLength = 80_000, tokens) => [
  { id: `u${id}`, role: 'user', content: '测'.repeat(textLength), files: [], createdAt: 1 },
  { id: `a${id}`, role: 'assistant', blocks: [{ type: 'text', text: '答' }], model: DEFAULT_MODEL, status: 'done', prefix: false, createdAt: 2, ...(tokens === undefined ? {} : { usage: usage(tokens) }) },
]
const session = (id, rounds, compaction) => ({ id, title: id, createdAt: 1, updatedAt: 2, messages: rounds.flat(), compaction })
const long = [round(1), round(2), round(3), round(4)]
const windowSize = 300_000
const threshold = getThresholdTokens(windowSize)

assert.equal(threshold, 201_696)
assert.equal(getThresholdTokens(1_400_000), 1_120_000)
for (const invalid of [null, NaN, Infinity, -1, 0, 98_304]) {
  assert.equal(resolveWindow(DEFAULT_MODEL, invalid), 1_000_000)
}
assert.equal(resolveWindow(DEFAULT_MODEL, 98_305), 98_305)
assert.equal(resolveWindow(DEFAULT_MODEL, windowSize), windowSize)
assert.equal(resolveWindow(DEFAULT_MODEL, 1_400_000), 1_400_000)
console.log('PASS 1 windows: 300000 -> 201696; 1400000 -> 1120000; invalid overrides -> default')

for (const window of [windowSize, 1_400_000]) {
  const limit = getThresholdTokens(window)
  for (const delta of [-1, 0, 1]) {
    const rounds = [round('b1', 400_000), round('b2', 400_000, limit + delta)]
    const result = evaluateCompaction(rounds, undefined, window)
    assert.equal(result.source, 'usage')
    assert.equal(result.pressure, limit + delta)
    assert.equal(result.triggered, delta > 0)
    assert.equal(shouldCompact(usage(limit + delta), window), delta > 0)
    assert.equal(result.reason, delta > 0 ? 'above-threshold' : 'below-threshold')
  }
}
console.log('PASS 2 boundaries (both windows): threshold-1=false; threshold=false; threshold+1=true')

clearLog()
const partial = { input_tokens: 210_000, cache_read_input_tokens: 20, output_tokens: 10 }
for (const event of [
  { type: 'message_start', message: { usage: partial } },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: partial },
]) {
  const parsed = readMessageEvent(event)
  const value = parsed.usage
  assert.deepEqual(value, { ...partial, cache_creation_input_tokens: 0 })
}
assert(getLogEntries().some((entry) => entry.message.includes('cache_creation_input_tokens')))
const parseUsage = (value) => readMessageEvent({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: value }).usage
assert.deepEqual(parseUsage({ output_tokens: 7, input_tokens: NaN }), { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 7 })
assert.equal(parseUsage({ input_tokens: Infinity }), undefined)
assert.equal(parseUsage(undefined), undefined)
console.log('PASS 3 partial usage: start/delta accepted, missing field zero-filled and logged; nonfinite rejected')

const estimated = evaluateCompaction(long, undefined, windowSize)
assert.equal(estimated.source, 'estimate')
assert.equal(estimated.pressure, estimateRoundsTokens(long))
assert.equal(estimated.triggered, true)
const zero = structuredClone(long)
zero.at(-1)[1].usage = { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 }
assert.deepEqual(evaluateCompaction(zero, undefined, windowSize), estimated)
assert.equal(evaluateCompaction([], undefined, windowSize).reason, 'no-usage-and-no-estimate')
assert.equal(evaluateCompaction([long[0]], undefined, windowSize).reason, 'nothing-to-compact')
console.log(`PASS 4 missing/all-zero usage: source=estimate, pressure=${estimated.pressure}, triggered=true`)

let mockMode = 'ok'
const requests = []
globalThis.fetch = async (_url, init) => {
  const body = JSON.parse(init.body)
  const isSummary = JSON.stringify(body.messages.at(-1)).includes('压缩引擎')
  requests.push({ body, isSummary })
  if (!isSummary && mockMode === 'overflow') {
    mockMode = 'ok'
    return new Response(JSON.stringify({ error: { message: 'context window exceeded' } }), { status: 400 })
  }
  if (isSummary && mockMode === 'request') throw new Error('mock summary failure')
  const text = isSummary ? (mockMode === 'empty-summary' ? '' : '已完成前序工作，继续当前任务。') : '正常回答'
  const events = [
    { type: 'message_start', message: { usage: usage(10) } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: usage(100) },
    { type: 'message_stop' },
  ]
  return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'Content-Type': 'text/event-stream' } })
}
const compactOptions = { envelope: { policy: { window: windowSize } } }
const result = await compactSession(session('unit', long), 'mock', undefined, compactOptions)
const checkpoint = { ...result, createdAt: 9_999 }
assert.equal(checkpoint.lastRoundId, 'a4')
assert.equal(evaluateCompaction(long, checkpoint, windowSize).reason, 'already-compacted')
const extended = [...long, round(5, 80_000, threshold + 1)]
assert.equal(evaluateCompaction(extended, checkpoint, windowSize).triggered, true)
const legacy = { ...checkpoint }
delete legacy.lastRoundId
assert.equal(evaluateCompaction(extended, legacy, windowSize).reason, 'already-compacted')
const later = structuredClone(extended)
later.at(-1)[1].createdAt = 10_000
assert.equal(evaluateCompaction(later, legacy, windowSize).triggered, true)
const retainedEstimate = evaluateCompaction([...long, round('estimate')], checkpoint, windowSize)
assert.equal(retainedEstimate.pressure, estimateRoundsTokens([long[3], round('estimate')]) + estimateTextTokens(frameCheckpoint(checkpoint.summary)))
await compactSession(session('again', extended, checkpoint), 'mock', undefined, compactOptions)
const repeated = requests.at(-1).body.messages
assert.equal(repeated[0].content, frameCheckpoint(checkpoint.summary))
assert.equal(repeated.length, 4)
console.log('PASS 5 no immediate repeat; new round triggers despite clock rollback; legacy time fallback; retained-history estimate')

const foreign = { ...checkpoint, upToMessageId: 'another-branch', lastRoundId: 'a4' }
for (const old of [foreign, { ...foreign, lastRoundId: undefined }]) {
  assert.deepEqual(evaluateCompaction(long, old, windowSize), estimated)
  const question = round('question', 1)[0]
  assert.deepEqual(toRequestMessages(long.flat(), question, undefined, false, undefined, old), toRequestMessages(long.flat(), question))
  await compactSession(session('branch', long, old), 'mock', undefined, compactOptions)
  assert(!JSON.stringify(requests.at(-1).body.messages.slice(0, -1)).includes('<compacted-summary>'))
}
assert.equal(toRequestMessages(long.flat(), round('question', 1)[0], undefined, false, undefined, checkpoint)[0].content, frameCheckpoint(checkpoint.summary))
console.log('PASS 6 foreign checkpoint ignored by evaluation, reply assembly and summary request; active anchor preserved')

setContextWindowOverride(windowSize)
assert.equal(storage.get('deepsleep:context-window-override'), '300000')
const reloaded = await import('../src/services/settings.ts?verify-reload')
assert.equal(reloaded.useSettings.getState().contextWindowOverride, windowSize)
setContextWindowOverride(null)
assert.equal(storage.has('deepsleep:context-window-override'), false)
assert.equal(useSettings.getState().contextWindowOverride, null)
setContextWindowOverride(Infinity)
assert.equal(useSettings.getState().contextWindowOverride, null)
console.log('PASS settings: persisted override reloads; blank removes override; invalid number normalized')

const db = await import('../src/services/chat/db.ts')
const { initChat, sendMessage, compactNow, useChatStore } = await import('../src/services/chat/store.ts')
const { setDraftText } = await import('../src/services/chat/drafts.ts')
useSettings.setState({ apiKey: 'mock' })
setContextWindowOverride(windowSize)
await initChat()
const seed = async (id, rounds) => {
  const value = session(id, rounds)
  await db.saveSession(value)
  useChatStore.setState((state) => ({ sessionCache: { ...state.sessionCache, [id]: value } }))
}
const send = async (id) => {
  setDraftText(id, '继续')
  assert.equal(sendMessage(id), true)
  for (let i = 0; i < 500 && useChatStore.getState().streaming[id] !== undefined; i++) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.equal(useChatStore.getState().streaming[id], undefined)
}
clearLog()
requests.length = 0
await seed('auto', long)
await send('auto')
assert.deepEqual(requests.map(({ isSummary }) => isSummary), [true, false])
assert.equal(useChatStore.getState().sessionCache.auto.compaction.lastRoundId, 'a4')
assert(JSON.stringify(requests[1].body.messages[0]).includes('<compacted-summary>'))
assert(getLogEntries().some((entry) => entry.scope === 'compaction' && entry.message.includes('"source":"estimate"') && entry.message.includes('"threshold":201696') && entry.message.includes('"triggered":true')))
await new Promise((resolve) => setTimeout(resolve, 100))
assert.equal((await db.loadSession('auto')).compaction.lastRoundId, 'a4')
for (const mode of ['empty-summary', 'request']) {
  mockMode = mode
  clearLog()
  requests.length = 0
  await seed(mode, long)
  await send(mode)
  assert.deepEqual(requests.map(({ isSummary }) => isSummary), [true, false])
  assert(getLogEntries().some((entry) => entry.scope === 'compaction' && entry.message.includes(`"reason":"${mode}"`)))
  assert.equal(useChatStore.getState().sessionCache[mode].compaction, undefined)
}
mockMode = 'ok'
await seed('short', [round('short', 10)])
assert.equal(await compactNow('short'), 'nothing')
assert(getLogEntries().some((entry) => entry.message.includes('"reason":"empty-range"')))
await seed('manual', long)
assert.equal(await compactNow('manual'), 'done')
assert.equal(useChatStore.getState().sessionCache.manual.compaction.lastRoundId, 'a4')
assert.equal(getContextRounds(useChatStore.getState().sessionCache.manual.messages).length, 4)
requests.length = 0
mockMode = 'overflow'
await seed('overflow', long.slice(0, 2))
await send('overflow')
assert.deepEqual(requests.map(({ isSummary }) => isSummary), [false, true, false])
assert.equal(useChatStore.getState().sessionCache.overflow.compaction.lastRoundId, 'a2')
assert.equal(COMPACTION_POLICY.outputReserve + COMPACTION_POLICY.headroom, 98_304)
console.log('PASS store integration: imported history auto-compacts; checkpoint persisted; errors logged and send continues; manual uses 300k budget; overflow retries with checkpoint')
console.log('ALL CHECKS PASSED')
