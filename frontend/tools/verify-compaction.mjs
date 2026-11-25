// 本地验收不访问真实 API，避免测试摘要消耗额度或修改用户会话。
// node --experimental-transform-types --import ./tools/run-ts.mjs tools/verify-compaction.mjs
import assert from 'node:assert/strict'
import { parseContextWindowInput } from '../src/services/settings.ts'
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
  assert.equal(resolveWindow(DEFAULT_MODEL, invalid), 1_048_576)
}
assert.equal(resolveWindow(DEFAULT_MODEL, 98_305), 98_305)
assert.equal(resolveWindow(DEFAULT_MODEL, windowSize), windowSize)
assert.equal(resolveWindow(DEFAULT_MODEL, 1400000), 1048576)
assert.equal(resolveWindow(DEFAULT_MODEL, null, {contextWindow:64000}),64000)
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

const screenshotOverflow = "This model's maximum context length is 1048576 tokens. However, you requested 1106215 tokens (1040179 in the messages, 66036 in the completion). Please reduce the length of the messages."
let mockMode = 'ok'
const requests = []
globalThis.fetch = async (_url, init) => {
  const body = JSON.parse(init.body)
  const isSummary = JSON.stringify(body.messages.at(-1)).includes('压缩引擎')
  requests.push({ body, isSummary })
  if (!isSummary && mockMode === 'per-message') {
    mockMode = 'ok'
    return new Response(JSON.stringify({ error: { message: 'user input too long, 33135 tokens exceeds max 32768 tokens (request_id: test)' } }), { status: 400 })
  }
  if (!isSummary && mockMode === 'overflow') {
    mockMode = 'ok'
    return new Response(JSON.stringify({ error: { message: screenshotOverflow } }), { status: 400 })
  }
  if (!isSummary && mockMode === 'lower-cap') {
    mockMode = 'ok'
    const error = "This model's maximum context length is 1048576 tokens. However, you requested 1072947 tokens (1040179 in the messages, 32768 in the completion)."
    assert.equal(body.max_tokens, 32768)
    return new Response(JSON.stringify({ error: { message: error } }), { status: 400 })
  }
  if (isSummary && mockMode === 'summary-overflow') {
    mockMode = 'ok'
    return new Response(JSON.stringify({ error: { message: screenshotOverflow } }), { status: 400 })
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

// —— 复审补充（1.3.13）——
// 附件只影响「原文总量」，不能给「摘要必须变小」兜正数；空串才重置窗口。
assert.equal(parseContextWindowInput(''), null)
assert.equal(parseContextWindowInput('abc'), null)
assert.equal(parseContextWindowInput('1.4m'), 1_400_000)
console.log('PASS extra: window parse (empty resets, invalid is null, 1.4m works)')

// Verify the exact Messages API envelope for chat and overflow recovery.
const { setModel, setThinking, setThinkingEffort, setSafetyLevel, setPromptPreferences } =
  await import('../src/services/settings.ts')
setContextWindowOverride(300_000)
setModel('deepseek-v4-pro')
setThinking(true)
setThinkingEffort('max')
setSafetyLevel('low')
setPromptPreferences([{ id: 'qa', name: 'Reviewer', text: 'Review the evidence first.' }], 'qa')
requests.length = 0
mockMode = 'overflow'
await seed('custom-envelope', long.slice(0, 2))
await send('custom-envelope')
assert.deepEqual(requests.map(({ isSummary }) => isSummary), [false, true, false])
for (const { body } of requests) {
  assert.equal(body.model, 'deepseek-v4-pro')
  assert.equal(body.system, 'Review the evidence first.')
  assert.deepEqual(body.thinking, { type: 'enabled' })
  assert.deepEqual(body.output_config, { effort: 'max' })
  assert.deepEqual(body.safety_check, { level: 'low' })
}
const savedReply = useChatStore.getState().sessionCache['custom-envelope'].messages.at(-1)
assert.deepEqual(savedReply.requestPreferences, {
  apiMode: 'extended', system: 'Review the evidence first.', effort: 'max', safetyLevel: 'low', window: 300_000,
})
await new Promise((resolve) => setTimeout(resolve, 100))
assert.deepEqual((await db.loadSession('custom-envelope')).messages.at(-1).requestPreferences, savedReply.requestPreferences)
setThinking(false)
requests.length = 0
await seed('thinking-off', [round('off', 10)])
await send('thinking-off')
assert.deepEqual(requests.at(-1).body.thinking, { type: 'disabled' })
assert.equal(requests.at(-1).body.output_config, undefined)
console.log('PASS preferences: custom model, system prompt, effort and safety match the summary/retry envelope')

const { continueReply } = await import('../src/services/chat/store.ts')
setModel('deepseek-flash')
setSafetyLevel('high')
setPromptPreferences([], null)
const savedSession = useChatStore.getState().sessionCache['custom-envelope']
useChatStore.setState((state) => ({
  sessionCache: {
    ...state.sessionCache,
    'custom-envelope': {
      ...savedSession,
      messages: savedSession.messages.map((message) => message.id === savedReply.id
        ? { ...message, status: 'stopped' }
        : message),
    },
  },
}))
requests.length = 0
continueReply('custom-envelope', savedReply.id)
for (let i = 0; i < 500 && useChatStore.getState().streaming['custom-envelope'] !== undefined; i++) {
  await new Promise((resolve) => setTimeout(resolve, 2))
}
const continued = requests.at(-1).body
assert.equal(continued.model, 'deepseek-v4-pro')
assert.equal(continued.system, 'Review the evidence first.')
assert.deepEqual(continued.output_config, { effort: 'max' })
assert.deepEqual(continued.safety_check, { level: 'low' })
console.log('PASS continuation: preferences survive changes to global settings')


const { getDraft } = await import('../src/services/chat/drafts.ts')
const { regenerateReply } = await import('../src/services/chat/store.ts')
const { setApiMode } = await import('../src/services/settings.ts')
setApiMode('extended')
requests.length = 0
mockMode = 'per-message'
await seed('per-message', [round('limit', 10)])
await send('per-message')
assert.equal(requests.length, 1, 'per-message rejection must not trigger compaction or retry')
const rejected = useChatStore.getState().sessionCache['per-message'].messages.at(-1)
assert.deepEqual(rejected.error.localMessage, {
  key: 'replySingleMessageLimit',
  params: { actual: '33135', limit: '32768' },
})
assert.equal(getDraft('per-message').text, '继续')
regenerateReply('per-message', rejected.id, 'standard')
for (let i = 0; i < 500 && useChatStore.getState().streaming['per-message'] !== undefined; i++) {
  await new Promise((resolve) => setTimeout(resolve, 2))
}
const standard = requests.at(-1).body
for (const field of ['tools', 'safety_check', 'title']) assert.equal(field in standard, false)
assert.ok(standard.messages.every((message) => message.role !== 'latest_reminder'))
assert.equal(useSettings.getState().apiMode, 'extended')
assert.equal(getDraft('per-message').text, '')
assert.equal(requests.length, 2, 'standard retry runs only on explicit invocation')
setApiMode('standard')
requests.length = 0
mockMode = 'overflow'
await seed('standard-overflow', long.slice(0, 2))
await send('standard-overflow')
assert.deepEqual(requests.map(({ isSummary }) => isSummary), [false, true, false])
for (const { body } of requests) {
  for (const field of ['tools', 'safety_check', 'title']) assert.equal(field in body, false)
}
console.log('PASS API modes: per-message limit, draft restoration, explicit standard retry, and standard compaction')

requests.length = 0
mockMode = 'summary-overflow'
const reduced = await compactSession(session('summary-overflow', long), 'mock', undefined, {
  ...compactOptions, urgent: true,
})
assert.equal(requests.length, 2)
assert(requests[1].body.messages.length < requests[0].body.messages.length)
assert.equal(reduced.upToMessageId, 'a2')
assert.equal(evaluateCompaction([round(1, 80000), round(2, 80000)], undefined, windowSize, COMPACTION_POLICY, 100000).triggered, true)
console.log('PASS screenshot overflow, smaller summary retry, and current message pressure')

const { readContextOverflow } = await import('../src/services/chat/compaction.ts')
assert.deepEqual(readContextOverflow(screenshotOverflow), { window:1048576,input:1040179,output:66036 })
assert.equal(readContextOverflow(screenshotOverflow.replace('1106215','1006215')), undefined)
requests.length = 0
mockMode = 'lower-cap'
await seed('lower-cap', [round('small-history', 10)])
await send('lower-cap')
assert.deepEqual(requests.map(({isSummary, body}) => [isSummary, body.max_tokens]), [[false,32768],[false,8141]])
console.log('PASS confirmed provider overflow retries once with a smaller wire output cap')

const { evaluateRequestContext, policyFor } = await import('../src/services/chat/compaction.ts')
const route = { model:DEFAULT_MODEL, apiMode:'standard', system:'system', thinking:false, search:false }
const large = [round('old-sample', 800000), round('last-sample', 600000, 170000)]
Object.assign(large[1][1], { model:DEFAULT_MODEL, thinking:false, search:false,
  requestPreferences:{ apiMode:'standard', system:'system' } })
const baseline = evaluateRequestContext(large, undefined, policyFor(1048576), route, '')
const withDraft = evaluateRequestContext(large, undefined, policyFor(1048576), route, 'draft')
assert.equal(baseline.source, 'estimate')
assert(baseline.pressure > 1000000)
assert(withDraft.pressure > baseline.pressure)
console.log('PASS a stale 170K sample cannot mask a 1M estimated request surface')
