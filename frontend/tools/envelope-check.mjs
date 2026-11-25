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
const webRequests = []
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
globalThis.fetch = async (url, init) => {
  const body = JSON.parse(init.body)
  if (url.endsWith('/v1/tools/search')) {
    webRequests.push(body)
    if (body.query === '模拟检索失败') return new Response(null, { status: 503 })
    return Response.json({
      results: [{ url: 'https://example.com/source', title: 'Source', summary: 'Evidence' }],
    })
  }
  if (url.endsWith('/v1/tools/fetch')) {
    webRequests.push(body)
    return Response.json({ title: 'Article', content: 'Extracted page text' })
  }
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
assert.equal(custom.tools, undefined)
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

for (const [apiMode, search, question] of [
  ['extended', false, '普通问题'],
  ['extended', true, '联网问题'],
  ['standard', false, '看看 https://example.com/article'],
  ['standard', true, '联网查询'],
  ['standard', true, '模拟检索失败'],
  ['standard', true, '看看 https://example.com/article'],
]) {
  useSettings.setState({ apiMode, search })
  records.length = 0
  webRequests.length = 0
  setDraftText(null, question)
  sendMessage(null)
  const id = useChatStore.getState().activeId
  await waitIdle(id)
  const body = records.find((record) => !record.isCompaction).body
  assert.equal(Boolean(body.tools), apiMode === 'extended' && search)
  assert.equal(Boolean(body.safety_check), apiMode === 'extended')
  assert.equal(webRequests.length, apiMode === 'standard' && search ? 1 : 0)
  if (apiMode === 'standard' && search) {
    const explicitUrl = question.includes('https://')
    assert.deepEqual(
      webRequests[0],
      explicitUrl
        ? { url: 'https://example.com/article' }
        : { query: question, count: 5, need_content: false }
    )
    const reply = (await db.loadSession(id)).messages.find(
      (message) => message.role === 'assistant'
    )
    const failed = question === '模拟检索失败'
    assert.equal(reply.clientWeb.status, failed ? 'failed' : 'found')
    assert.equal(
      JSON.stringify(body.messages).includes(explicitUrl ? 'Extracted page text' : 'Evidence'),
      !failed
    )
  }
}
console.log('PASS 两种 API 模式的联网开关和标准模式读链接')

// Exercise custom routing through the same store and stream pipeline as a real send.
const { setConnection } = await import('../src/services/settings.ts')
const { transcribe, synthesize } = await import('../src/services/api/speech.ts')
const { connectionFor } = await import('../src/services/api/connections.ts')
assert.equal(
  setConnection('chat', {
    provider: 'custom',
    base: 'http://example.com/v1',
    key: '',
    model: 'demo',
  }),
  false
)
assert.equal(
  setConnection('chat', {
    provider: 'opencode',
    base: '',
    key: 'mock-chat-key',
    model: 'deepseek-v4-pro',
  }),
  true
)
for (const service of ['search', 'fetch']) {
  assert.equal(
    setConnection(service, {
      provider: 'tavily',
      base: '',
      key: 'mock-' + service + '-key',
      model: '',
    }),
    true
  )
}
for (const service of ['asr', 'tts']) {
  assert.equal(
    setConnection(service, {
      provider: 'custom',
      base: 'https://voice.example.com/' + service,
      key: 'mock-' + service + '-key',
      model: '',
    }),
    true
  )
}
assert.ok(
  !JSON.parse(localStorage.getItem('deepsleep:service-connections')).chat.base.includes(
    'mock-chat-key'
  )
)
const standardFetch = globalThis.fetch
const routed = []
globalThis.__deepsleepNative = { getOpenCodeNonce: () => 'mock-native-nonce' }
globalThis.fetch = async (url, init) => {
  if (
    !url.includes('tavily.com') &&
    !url.includes('voice.example.com') &&
    url !== '/api/opencode/chat'
  ) {
    return standardFetch(url, init)
  }
  const record = { url, headers: new Headers(init.headers), body: init.body }
  routed.push(record)
  if (url.endsWith('/search')) {
    return Response.json({
      results: [{ url: 'https://example.com/result', content: 'Tavily source' }],
    })
  }
  if (url.endsWith('/extract')) {
    return Response.json({
      results: [{ url: 'https://example.com/article', raw_content: 'Tavily excerpt' }],
    })
  }
  if (url.endsWith('/asr')) {
    assert.ok(init.body instanceof FormData)
    return Response.json({ text: 'recognized audio' })
  }
  if (url.endsWith('/tts')) {
    return new Response(new Uint8Array([1, 2]))
  }
  assert.equal(record.headers.get('x-deepsleep-opencode'), 'mock-native-nonce')
  const chunks = [
    { id: 'custom', choices: [{ delta: { reasoning_content: 'reason' }, finish_reason: null }] },
    { id: 'custom', choices: [{ delta: { content: 'Compatible reply' }, finish_reason: 'stop' }] },
  ]
  return new Response(chunks.map((chunk) => 'data: ' + JSON.stringify(chunk) + '\n\n').join(''), {
    headers: { 'Content-Type': 'text/event-stream' },
  })
}
for (const [apiMode, search, question, expected] of [
  ['standard', true, '混合检索', ['https://api.tavily.com/search', '/api/opencode/chat']],
  [
    'standard',
    true,
    '看看 https://example.com/article',
    ['https://api.tavily.com/extract', '/api/opencode/chat'],
  ],
  ['standard', false, '只聊天', ['/api/opencode/chat']],
  ['extended', false, '使用默认服务', []],
]) {
  useSettings.setState({ apiMode, search })
  routed.length = 0
  setDraftText(null, question)
  sendMessage(null)
  const id = useChatStore.getState().activeId
  await waitIdle(id)
  assert.deepEqual(
    routed.map((call) => call.url),
    expected
  )
  if (apiMode === 'standard') {
    const chat = routed.at(-1)
    assert.equal(chat.headers.get('authorization'), 'Bearer mock-chat-key')
    const body = JSON.parse(chat.body)
    assert.equal(body.model, 'deepseek-v4-pro')
    assert.equal(body.tools, undefined)
    assert.equal(body.safety_check, undefined)
    assert.ok(!chat.body.includes('mock-'))
    const reply = (await db.loadSession(id)).messages.find(
      (message) => message.role === 'assistant'
    )
    assert.equal(reply.requestPreferences.externalModel, 'deepseek-v4-pro')
    assert.ok(JSON.stringify(reply.blocks).includes('Compatible reply'))
    if (search) {
      assert.equal(
        routed[0].headers.get('authorization'),
        'Bearer mock-' + (question.includes('https://') ? 'fetch' : 'search') + '-key'
      )
      assert.ok(
        chat.body.includes(question.includes('https://') ? 'Tavily excerpt' : 'Tavily source')
      )
    }
  }
}
useSettings.setState({ apiMode: 'standard' })
routed.length = 0
const settings = useSettings.getState()
const audio = new Blob([new Uint8Array([1, 2])])
const controller = new AbortController()
assert.equal(
  await transcribe('', audio, controller.signal, connectionFor(settings, 'asr')),
  'recognized audio'
)
const speech = await synthesize(
  '',
  'hello',
  'stella',
  controller.signal,
  connectionFor(settings, 'tts')
)
assert.deepEqual((await speech.getReader().read()).value, new Uint8Array([1, 2]))
assert.deepEqual(
  routed.map((call) => call.headers.get('authorization')),
  ['Bearer mock-asr-key', 'Bearer mock-tts-key']
)
assert.equal(setConnection('chat', null), true)
assert.equal(connectionFor(useSettings.getState(), 'chat'), undefined)
console.log(
  'PASS standard-mode providers, native OpenCode route, isolated keys, web lookup, voice, and reset'
)

const { streamCompatibleChat } = await import('../src/services/api/compatibleChat.ts')
const { fetchProviderModels } = await import('../src/services/api/modelCatalog.ts')
const signal = new AbortController().signal
const connection = { provider: 'opencode', base: 'https://opencode.ai/inference/openai/v1', key: 'mock-open', model: 'gpt-example', effort: 'high' }
const requestBody = { max_tokens: 4096, system: 'System message', model: 'deepseek-flash', messages: [{role:'user',content:'Hello'}] }
const sse = (frames) => new Response(frames.map((frame) => 'data: ' + JSON.stringify(frame) + '\n\n').join(''), {
  headers: { 'content-type': 'text/event-stream' },
})
globalThis.fetch = async (url, init) => {
  if (url === '/api/opencode/models') {
    return Response.json({opencode:{models:{
      sample: {id:'gpt-example',api:{responses:{}},capabilities:{reasoning:{effort:['low','high']}}},
      claude: {id:'claude-example',api:{messages:{}}},
      free: {id:'example-free',api:{'chat-completions':{}}},
      gemini: {id:'gemini-example',api:{'generate-content':{}}},
    }}})
  }
  const body = JSON.parse(init.body)
  if (url === '/api/opencode/responses') {
    assert.deepEqual(body.reasoning, { effort: 'high' })
    assert.equal(body.max_output_tokens, 4096)
    assert.equal(body.input.at(-1).content, 'Hello')
    assert.equal(body.messages, undefined)
    return sse([
      {type:'response.created',response:{id:'r-1'}},
      {type:'response.output_text.delta',delta:'Responses works'},
      {type:'response.completed',response:{usage:{input_tokens:25,output_tokens:5,input_tokens_details:{cached_tokens:5}}}},
    ])
  }
  if (url === '/api/opencode/messages') {
    assert.equal(body.system, 'System message')
    assert.equal(body.max_tokens, 4096)
    assert.equal(body.messages.length, 1)
    assert.equal(body.reasoning, undefined)
    return sse([
      {type:'message_start',message:{id:'m-1',model:'claude-example',usage:{input_tokens:10,output_tokens:0}}},
      {type:'content_block_start',index:0,content_block:{type:'text',text:'Messages works'}},
      {type:'content_block_stop',index:0},
      {type:'message_delta',delta:{stop_reason:'end_turn',stop_sequence:null},usage:{output_tokens:6}},
      {type:'message_stop'},
    ])
  }
  if (url === '/api/opencode/chat') {
    assert.deepEqual(body.stream_options,{include_usage:true})
    assert.equal(body.max_tokens, 4096)
    return sse([
      {id:'chat-1',choices:[{delta:{content:'Chat Completions works'},finish_reason:'stop'}]},
      {choices:[],usage:{prompt_tokens:30,completion_tokens:7}},
    ])
  }
  assert.equal(url, 'https://api.siliconflow.cn/v1/chat/completions')
  assert.equal(body.reasoning_effort,'max')
  assert.equal(body.max_tokens, undefined)
  assert.equal(body.enable_thinking,true)
  return sse([{choices:[{delta:{content:'SiliconFlow works'},finish_reason:'stop'}]}])
}
const catalog = await fetchProviderModels('opencode','mock-open',signal)
assert.deepEqual(catalog.models,['claude-example','gpt-example'])
assert.deepEqual(catalog.routes['gpt-example'],{protocol:'responses',efforts:['low','high']})
for (const [route, expected, output] of [
  [connection, 'Responses works', 5],
  [{...connection, model:'claude-example', protocol:'messages'}, 'Messages works', 6],
  [{...connection, model:'chat-example', protocol:'chat-completions'}, 'Chat Completions works',7],
  [{...connection, provider:'siliconflow', base:'https://api.siliconflow.cn/v1', model:'deepseek-ai/DeepSeek-V4-Flash', effort:'max'},'SiliconFlow works',undefined],
]) {
  const events=[]
  for await (const event of streamCompatibleChat(route, requestBody, signal)) events.push(event)
  assert.ok(JSON.stringify(events).includes(expected))
  assert.equal(events.find((event) => event.type === 'message_delta')?.usage?.output_tokens,output)
  assert.equal(events.at(-1).type,'message_stop')
}
console.log('PASS OpenCode catalog and three protocol routes, final usage, and SiliconFlow effort')
