// 定向故障测试：API 连接/响应超时、响应体读取上限、SSE 空闲上限、取消语义与监听清理。
//
// 用法（frontend 下）：
//   node --experimental-transform-types --import ./tools/run-ts.mjs tools/api-timeout.mjs
//
// 全部用假 fetch 与假流，不访问网络。断言的是：
//   1. 响应头迟迟不来 → ApiError('timeout')，且只发一次请求（不自动重放）
//   2. 用户主动停止（响应头之前）→ 原样取消原因，不等到超时
//   3. 响应头到手后计时器撤掉 → 之后慢慢读响应体仍然成功（不掐断正常长流）
//   4. 非 2xx「头立即到、body 永不结束」→ 有界失败，保留 HTTP 状态，底层流被取消
//   5. 非 SSE 响应（协议不符）+ body 永不结束 → 有界失败，底层流被取消
//   6. 读错误正文期间用户取消 → 原样取消原因，不报成 HTTP/超时
//   7. 预取消的 signal：请求与响应体读取都立即结束，不等响应头超时、也不等空闲上限
//   8. 同一个 signal 被反复复用 → 监听数与解除数相等（不累积）
//   9. SSE 空闲超时 → ApiError('timeout')，底层流取消且 reader 锁已释放
//  10. SSE 正常连续出帧（总时长超过空闲上限）→ 照常读完，不误判
//  11. 流读一半用户取消 → 不报超时，立即结束，reader 锁已释放
import assert from 'node:assert/strict'

const storage = new Map()
globalThis.localStorage = {
  getItem: (key) => storage.get(key) ?? null,
  setItem: (key, value) => storage.set(key, String(value)),
  removeItem: (key) => storage.delete(key),
}
globalThis.window = globalThis
globalThis.__API_ORIGIN__ = 'http://timeout.invalid'

const { ApiError, readBodyText, request, streamMessage } =
  await import('../src/services/api/client.ts')
const { translate } = await import('../src/i18n/index.ts')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const encoder = new TextEncoder()
const origin = globalThis.__API_ORIGIN__
const abortError = () => new DOMException('The operation was aborted.', 'AbortError')

/** 假 fetch：记下调用次数；handler 自己决定怎么响应 */
const installFetch = (handler) => {
  const calls = []
  globalThis.fetch = (url, init) => {
    calls.push({ url, signal: init?.signal })
    return handler(url, init, calls)
  }
  return calls
}

/** 按真实 fetch 的行为：signal 已取消就立即 reject，否则等取消 */
const hangUntilAborted = (init) => {
  if (init.signal.aborted) {
    return Promise.reject(init.signal.reason ?? abortError())
  }
  return new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(init.signal.reason ?? abortError()), {
      once: true,
    })
  })
}

/** 永不结束、也不给任何字节的响应体 */
const hangingBody = (onCancel) =>
  new ReadableStream({
    start() {
      // 故意什么都不做：头到了、body 永不结束
    },
    cancel(reason) {
      onCancel?.(reason)
    },
  })

const sseBody = (events) =>
  events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('')

// ---- 1. 响应头超时 ------------------------------------------------------------
{
  const calls = installFetch((_url, init) => hangUntilAborted(init))
  const started = Date.now()
  const error = await request(
    `${origin}/models`,
    { method: 'GET' },
    { responseTimeoutMs: 40 }
  ).then(
    () => null,
    (caught) => caught
  )
  const elapsed = Date.now() - started
  assert.ok(error instanceof ApiError, '响应头超时应抛 ApiError')
  assert.equal(error.kind, 'timeout')
  assert.equal(error.status, undefined)
  assert.equal(error.message, translate('apiTimeout'), '超时文案要能直接展示给用户')
  assert.equal(calls.length, 1, '超时后不得自动重放')
  assert.ok(elapsed >= 30 && elapsed < 2_000, `超时判定应在计时器附近完成，实际 ${elapsed}ms`)
  console.log(
    `PASS 1 响应头超时：ApiError(timeout) "${error.message}"，${elapsed}ms，请求次数 ${calls.length}`
  )
}

// ---- 2. 用户取消优先于超时 -----------------------------------------------------
{
  const reason = new DOMException('用户点了停止', 'AbortError')
  const calls = installFetch((_url, init) => hangUntilAborted(init))
  const user = new AbortController()
  const started = Date.now()
  const pending = request(
    `${origin}/models`,
    { signal: user.signal },
    { responseTimeoutMs: 5_000 }
  ).then(
    () => null,
    (caught) => caught
  )
  setTimeout(() => user.abort(reason), 20)
  const error = await pending
  const elapsed = Date.now() - started
  assert.equal(error, reason, '取消原因必须原样保留')
  assert.ok(!(error instanceof ApiError), `用户取消不应改写成 ApiError，实际 ${error}`)
  assert.ok(elapsed < 1_000, `取消应立即生效，实际 ${elapsed}ms`)
  assert.equal(calls.length, 1)
  console.log(`PASS 2 调用方取消：原样取消原因（${error.name}），${elapsed}ms 内结束，未被报成超时`)
}

// ---- 3. 响应头到手后撤计时器（不影响正常长流） ---------------------------------
{
  installFetch(async () => {
    const body = new ReadableStream({
      async start(controller) {
        await sleep(120)
        controller.enqueue(encoder.encode('late-body-ok'))
        controller.close()
      },
    })
    return new Response(body, { status: 200 })
  })
  const response = await request(`${origin}/models`, {}, { responseTimeoutMs: 40 })
  const text = await readBodyText(response)
  assert.equal(text, 'late-body-ok', '超时只覆盖响应头，读响应体不应被打断')
  console.log(
    'PASS 3 超时只覆盖响应头：响应体 120ms 后仍完整读到（流式长回答不会被自己的超时掐断）'
  )
}

// ---- 4. 非 2xx：头立即到、body 永不结束 ---------------------------------------
{
  let cancelled = false
  installFetch(
    async () =>
      new Response(
        hangingBody(() => {
          cancelled = true
        }),
        { status: 502, statusText: 'Bad Gateway' }
      )
  )
  const started = Date.now()
  const error = await request(`${origin}/messages`, {}, { errorBodyTimeoutMs: 60 }).then(
    () => null,
    (caught) => caught
  )
  const elapsed = Date.now() - started
  assert.ok(error instanceof ApiError, `非 2xx 应抛 ApiError，实际 ${error}`)
  assert.equal(error.kind, 'http')
  assert.equal(error.status, 502, 'HTTP 状态必须保留')
  assert.equal(error.message, 'Bad Gateway', '没读到正文时退回 statusText')
  assert.ok(cancelled, '超时后必须取消响应体，释放连接')
  assert.ok(elapsed < 1_500, `错误正文读取必须有界，实际 ${elapsed}ms`)
  console.log(
    `PASS 4 非 2xx + body 不结束：${elapsed}ms 后 ApiError(http, status=${error.status})，body 已取消`
  )
}

// ---- 5. 非 SSE 响应 + body 永不结束 ------------------------------------------
{
  let cancelled = false
  installFetch(
    async () =>
      new Response(
        hangingBody(() => {
          cancelled = true
        }),
        { status: 200, headers: { 'Content-Type': 'text/html' } }
      )
  )
  const body = { model: 'deepseek-flash', messages: [{ role: 'user', content: 'hi' }] }
  const started = Date.now()
  const error = await streamMessage('sk-mock', body, new AbortController().signal, {
    errorBodyTimeoutMs: 60,
  })
    .next()
    .then(
      () => null,
      (caught) => caught
    )
  const elapsed = Date.now() - started
  assert.ok(error instanceof ApiError, `协议不符应抛 ApiError，实际 ${error}`)
  assert.equal(error.kind, 'protocol')
  assert.ok(cancelled, '协议错误路径同样要取消响应体')
  assert.ok(elapsed < 1_500, `协议错误必须有界，实际 ${elapsed}ms`)
  console.log(`PASS 5 非 SSE + body 不结束：${elapsed}ms 后 ApiError(protocol)，body 已取消`)
}

// ---- 6. 读错误正文期间用户取消 -------------------------------------------------
{
  installFetch(async () => new Response(hangingBody(), { status: 500 }))
  const user = new AbortController()
  const reason = new DOMException('用户点了停止', 'AbortError')
  setTimeout(() => user.abort(reason), 20)
  const error = await request(
    `${origin}/models`,
    { signal: user.signal },
    { errorBodyTimeoutMs: 5_000 }
  ).then(
    () => null,
    (caught) => caught
  )
  assert.equal(error, reason, '错误正文读取中的取消同样要原样保留原因')
  assert.ok(!(error instanceof ApiError))
  console.log('PASS 6 错误正文读取中取消：原样取消原因，不报成 HTTP/超时')
}

// ---- 7. 预取消的 signal 不等任何计时 ------------------------------------------
{
  installFetch((_url, init) => hangUntilAborted(init))
  const user = new AbortController()
  const reason = new DOMException('用户提前点了停止', 'AbortError')
  user.abort(reason)
  const started = Date.now()
  const error = await request(
    `${origin}/models`,
    { signal: user.signal },
    { responseTimeoutMs: 5_000 }
  ).then(
    () => null,
    (caught) => caught
  )
  const requestElapsed = Date.now() - started
  assert.equal(error, reason)
  assert.ok(requestElapsed < 100, `预取消的请求不应等响应头超时，实际 ${requestElapsed}ms`)

  // 响应体读取同样要立即结束：不能等 timeoutMs，且取消原因要原样抛出
  let cancelled = false
  const stream = hangingBody(() => {
    cancelled = true
  })
  const bodyStarted = Date.now()
  const bodyError = await readBodyText(new Response(stream), {
    signal: user.signal,
    timeoutMs: 5_000,
  }).then(
    () => null,
    (caught) => caught
  )
  const bodyElapsed = Date.now() - bodyStarted
  assert.equal(bodyError, reason, '预取消的响应体读取要原样抛取消原因')
  assert.ok(cancelled, '预取消时响应体必须被取消')
  assert.equal(stream.locked, false, '读取退出后必须释放锁')
  assert.ok(bodyElapsed < 100, `预取消的读取不应等计时器，实际 ${bodyElapsed}ms`)

  // 流式链路同样不能等空闲上限
  const streamStarted = Date.now()
  const streamError = await streamMessage(
    'sk-mock',
    { model: 'deepseek-flash', messages: [{ role: 'user', content: 'hi' }] },
    user.signal,
    { idleTimeoutMs: 5_000 }
  )
    .next()
    .then(
      () => null,
      (caught) => caught
    )
  const streamElapsed = Date.now() - streamStarted
  assert.equal(streamError, reason)
  assert.ok(streamElapsed < 100, `预取消的流不应等空闲上限，实际 ${streamElapsed}ms`)
  console.log(
    `PASS 7 预取消 signal：请求 ${requestElapsed}ms、body ${bodyElapsed}ms、流 ${streamElapsed}ms 立即结束`
  )
}

// ---- 8. 复用同一个 signal：监听不累积 -----------------------------------------
{
  const counts = { add: 0, remove: 0 }
  const user = new AbortController()
  const signal = user.signal
  const add = signal.addEventListener.bind(signal)
  const remove = signal.removeEventListener.bind(signal)
  signal.addEventListener = (type, listener, options) => {
    counts.add += 1
    add(type, listener, options)
  }
  signal.removeEventListener = (type, listener, options) => {
    counts.remove += 1
    remove(type, listener, options)
  }

  let failing = false
  let cancelling = false
  installFetch(async (_url, init) => {
    if (cancelling) {
      // 让取消发生在「等响应头」期间
      if (init.signal.aborted) {
        throw init.signal.reason
      }
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true })
      })
    }
    if (failing) {
      return new Response('{"error":{"message":"boom"}}', { status: 500 })
    }
    return new Response('ok', { status: 200 })
  })

  for (let i = 0; i < 6; i += 1) {
    const response = await request(`${origin}/models`, { signal })
    await readBodyText(response)
  }
  failing = true
  for (let i = 0; i < 6; i += 1) {
    const error = await request(`${origin}/models`, { signal }).then(
      () => null,
      (caught) => caught
    )
    assert.ok(error instanceof ApiError && error.kind === 'http')
  }
  cancelling = true
  for (let i = 0; i < 3; i += 1) {
    const pending = request(`${origin}/models`, { signal }).then(
      () => null,
      (caught) => caught
    )
    await sleep(10)
    user.abort(new DOMException('stop once', 'AbortError'))
    await pending
  }
  assert.equal(
    counts.add,
    counts.remove,
    `监听必须成对解除：add=${counts.add} remove=${counts.remove}`
  )
  // 每次请求最多两段（等响应头 + 读错误正文），取消后 signal 已中止的那几次不再注册
  assert.ok(counts.add <= 2 * 15, `每次请求最多两个转发监听，实际 ${counts.add}`)
  console.log(
    `PASS 8 复用同一 signal 15 次（成功/失败/取消）：监听 add=${counts.add} remove=${counts.remove}`
  )
}

// ---- SSE 场景 ---------------------------------------------------------------
const startEvent = { type: 'message_start', message: { id: 'msg_1', usage: { input_tokens: 1 } } }
const stopEvent = { type: 'message_stop' }
const chatBody = { model: 'deepseek-flash', messages: [{ role: 'user', content: 'hi' }] }

const sseFetch = (source, onCancel) => {
  const state = { cancelled: false, stream: null }
  installFetch(async () => {
    const stream = new ReadableStream({
      start: (controller) => source(controller),
      cancel: (reason) => {
        state.cancelled = true
        onCancel?.(reason)
      },
    })
    state.stream = stream
    return new Response(stream, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    })
  })
  return state
}

const drain = async (signal, idleTimeoutMs) => {
  const types = []
  try {
    for await (const event of streamMessage('sk-mock', chatBody, signal, { idleTimeoutMs })) {
      types.push(event.type)
    }
    return { types, error: null }
  } catch (error) {
    return { types, error }
  }
}

// ---- 9. SSE 空闲上限 + reader 清理 -------------------------------------------
{
  const state = sseFetch((controller) => {
    // 首帧给完就彻底安静：服务端连着但一个字节都不再来
    controller.enqueue(encoder.encode(sseBody([startEvent])))
  })
  const started = Date.now()
  const { types, error } = await drain(new AbortController().signal, 60)
  const elapsed = Date.now() - started
  assert.deepEqual(types, ['message_start'], '空闲超时前的帧应正常产出')
  assert.ok(error instanceof ApiError, `SSE 空闲应抛 ApiError，实际 ${error}`)
  assert.equal(error.kind, 'timeout')
  assert.equal(error.message, translate('apiTimeout'))
  assert.ok(state.cancelled, '空闲超时必须取消底层流，释放连接')
  assert.equal(state.stream.locked, false, '空闲超时后必须释放 reader 锁')
  assert.ok(elapsed < 1_500, `空闲判定应在计时器附近完成，实际 ${elapsed}ms`)
  console.log(`PASS 9 SSE 空闲超时：${elapsed}ms 后 ApiError(timeout)，流已取消、锁已释放`)
}

// ---- 10. 正常连续出帧不被误判 ------------------------------------------------
{
  const state = sseFetch((controller) => {
    // 5 帧、每 20ms 一帧：总时长 100ms，超过 60ms 的空闲上限，但每帧都续期
    const frames = [startEvent, startEvent, startEvent, startEvent, stopEvent]
    void (async () => {
      for (const frame of frames) {
        await sleep(20)
        controller.enqueue(encoder.encode(sseBody([frame])))
      }
      controller.close()
    })()
  })
  const { types, error } = await drain(new AbortController().signal, 60)
  assert.equal(error, null, `正常长流不应报错，实际 ${error}`)
  assert.equal(types.at(-1), 'message_stop')
  assert.equal(types.length, 5)
  assert.equal(state.cancelled, false, '正常读完不应取消流')
  assert.equal(state.stream.locked, false, '正常读完也要释放 reader 锁')
  console.log('PASS 10 正常长流：5 帧共 100ms（> 60ms 空闲上限）全部收完，无超时误判、锁已释放')
}

// ---- 11. 流读一半用户取消 ----------------------------------------------------
{
  const state = sseFetch((controller) => {
    controller.enqueue(encoder.encode(sseBody([startEvent])))
    // 之后不再出帧，靠用户取消结束
  })
  const user = new AbortController()
  const reason = new DOMException('用户点了停止', 'AbortError')
  const started = Date.now()
  setTimeout(() => user.abort(reason), 30)
  const { error } = await drain(user.signal, 5_000)
  const elapsed = Date.now() - started
  assert.ok(error !== null, '取消后不应装作正常结束')
  assert.ok(
    !(error instanceof ApiError) || error.kind !== 'timeout',
    `用户取消不能被报成超时，实际 kind=${error instanceof ApiError ? error.kind : error?.name}`
  )
  assert.equal(state.stream.locked, false, '取消后必须释放 reader 锁')
  assert.ok(elapsed < 1_000, `取消应立即结束，实际 ${elapsed}ms`)
  console.log(
    `PASS 11 流中取消：${elapsed}ms 结束，错误为 ${error.name}${error instanceof ApiError ? `(${error.kind})` : ''}，不是超时，锁已释放`
  )
}

// ---- 12. 超时在界面上是一句人话 ----------------------------------------------
{
  const { describeReply } = await import('../src/services/chat/describe.ts')
  const timeout = new ApiError('timeout', { key: 'apiTimeout' })
  const notice = describeReply({
    status: 'error',
    error: { kind: timeout.kind, message: timeout.message, localMessage: timeout.localMessage },
    blocks: [],
  })
  assert.equal(notice?.text, translate('apiTimeout'))
  console.log(`PASS 12 超时提示：界面上显示「${notice?.text}」`)
}

// ---- 13. 错误正文读取失败：仍必须是 ApiError(http, status)，不是裸 TypeError ------
{
  const failingBody = () =>
    new ReadableStream({
      start(controller) {
        // 头到手后连接被重置：正文一个字节都没读到
        controller.error(new TypeError('socket reset'))
      },
    })
  installFetch(async () => new Response(failingBody(), { status: 503, statusText: 'Unavailable' }))
  const error = await request(`${origin}/models`, {}).then(
    () => null,
    (caught) => caught
  )
  assert.ok(error instanceof ApiError, `正文读取失败不能变成裸错误，实际 ${error}`)
  assert.equal(error.kind, 'http')
  assert.equal(error.status, 503, '状态码必须保留')
  assert.equal(error.message, 'Unavailable', '读不到正文时用 statusText 兜底')

  // 同样的 503 上，用户取消仍然优先：原样抛取消原因，不改写成 ApiError
  const user = new AbortController()
  const reason = new DOMException('用户点了停止', 'AbortError')
  user.abort(reason)
  const cancelError = await request(`${origin}/models`, { signal: user.signal }).then(
    () => null,
    (caught) => caught
  )
  assert.equal(cancelError, reason, '取消优先于 HTTP 错误')
  console.log(
    `PASS 13 错误正文读取失败：ApiError(${error.kind}, status=${error.status}) "${error.message}"；取消仍原样抛出`
  )
}

console.log('全部通过：超时/空闲能被判出，响应体读取有界，取消与监听清理都正确')
