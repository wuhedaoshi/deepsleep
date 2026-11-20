/**
 * SSE（text/event-stream）解析，按 WHATWG 规范实现：
 * https://html.spec.whatwg.org/multipage/server-sent-events.html#event-stream-interpretation
 *
 * 字节流 → UTF-8 解码 → 按 CRLF / LF / CR 切行 → 字段累积 → 空行派发事件。
 * 注释行（如服务端保活的 `: keep-alive`）直接忽略；`retry` 只对 EventSource 重连有意义，这里不处理。
 */

export type ServerSentEvent = {
  /** `event` 字段，缺省为 `message` */
  event: string
  /** 多行 `data` 以 `\n` 连接 */
  data: string
  /** 最近一次 `id` 字段 */
  lastEventId: string
}

const LINE_BREAK = /\r\n|\r|\n/g

export class ServerSentEventDecoder {
  private buffer = ''
  private data = ''
  private hasData = false
  private eventType = ''
  private lastEventId = ''

  /** 输入一段已解码的文本，返回其中完整的事件 */
  push(text: string): ServerSentEvent[] {
    this.buffer += text
    const events: ServerSentEvent[] = []
    let lineStart = 0
    LINE_BREAK.lastIndex = 0
    for (let match = LINE_BREAK.exec(this.buffer); match; match = LINE_BREAK.exec(this.buffer)) {
      // 结尾的 CR 可能是 CRLF 的前半，等下一段再判断
      if (match[0] === '\r' && LINE_BREAK.lastIndex === this.buffer.length) {
        break
      }
      const event = this.processLine(this.buffer.slice(lineStart, match.index))
      if (event) {
        events.push(event)
      }
      lineStart = LINE_BREAK.lastIndex
    }
    this.buffer = this.buffer.slice(lineStart)
    return events
  }

  /** 流结束：结尾的 CR 是完整的换行，其余未以空行结尾的事件按规范丢弃 */
  end(): ServerSentEvent[] {
    const event = this.buffer.endsWith('\r') ? this.processLine(this.buffer.slice(0, -1)) : null
    this.buffer = ''
    this.data = ''
    this.hasData = false
    this.eventType = ''
    return event ? [event] : []
  }

  private processLine(line: string): ServerSentEvent | null {
    if (line === '') {
      return this.dispatch()
    }
    if (line.startsWith(':')) {
      return null
    }
    const colon = line.indexOf(':')
    const field = colon === -1 ? line : line.slice(0, colon)
    let value = colon === -1 ? '' : line.slice(colon + 1)
    if (value.startsWith(' ')) {
      value = value.slice(1)
    }
    switch (field) {
      case 'data':
        this.data = this.hasData ? `${this.data}\n${value}` : value
        this.hasData = true
        break
      case 'event':
        this.eventType = value
        break
      case 'id':
        if (!value.includes('\0')) {
          this.lastEventId = value
        }
        break
      default:
        break
    }
    return null
  }

  private dispatch(): ServerSentEvent | null {
    const event: ServerSentEvent | null = this.hasData
      ? { event: this.eventType || 'message', data: this.data, lastEventId: this.lastEventId }
      : null
    this.data = ''
    this.hasData = false
    this.eventType = ''
    return event
  }
}

/**
 * 流在 `idleTimeoutMs` 内一个字节都没收到。
 *
 * 为什么不用 AbortError 表示：用户主动停止同样会取消读取，两者必须能分开——
 * 一个是「连接死了该报错」，一个是「用户就是想停」。这里单独一个类型，由上层翻译成 ApiError。
 */
export class SseIdleTimeoutError extends Error {
  constructor(readonly idleTimeoutMs: number) {
    super(`SSE idle for ${idleTimeoutMs}ms`)
    this.name = 'SseIdleTimeoutError'
  }
}

/**
 * 逐个产出字节流中的 SSE 事件；流读完即结束。
 * 中止或调用方提前退出时取消读取以释放连接，不依赖底层网络把中止传到响应体。
 *
 * 传了 `idleTimeoutMs` 时，每次 `read()` 都有一个独立的空闲上限：正常长流每收到一段就续期，
 * 只有「服务端连着、但一个字节都不再给」才会命中——那正是弱网或切后台后 TCP 半开的样子。
 * 命中后取消读取（连接随之关闭）并抛 `SseIdleTimeoutError`，不重连、不重放。
 */
export async function* readServerSentEvents(
  stream: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
  idleTimeoutMs?: number
): AsyncGenerator<ServerSentEvent> {
  const reader = stream.getReader()
  const cancel = () => {
    reader.cancel(signal?.reason).catch(() => {})
  }
  const onAbort = () => cancel()
  // 已经取消的 signal 不会再发事件：这里不自查，就得白等到空闲上限才结束
  if (signal?.aborted) {
    cancel()
  } else {
    signal?.addEventListener('abort', onAbort, { once: true })
  }
  const idleMs = idleTimeoutMs
  let idleTimer: ReturnType<typeof setTimeout> | undefined
  /** 命中空闲上限的那次等待：read() 被 cancel() 结束成 done，不会有异常，只能靠这个标记判断 */
  let idleExpired = false
  const disarmIdle = () => {
    if (idleTimer !== undefined) {
      clearTimeout(idleTimer)
      idleTimer = undefined
    }
  }
  const armIdle = () => {
    if (idleMs === undefined) {
      return
    }
    disarmIdle()
    idleTimer = setTimeout(() => {
      idleTimer = undefined
      idleExpired = true
      cancel()
    }, idleMs)
  }
  // TextDecoder 默认会去掉开头的 BOM；stream: true 保证多字节字符跨分片时不被截断
  const textDecoder = new TextDecoder()
  const decoder = new ServerSentEventDecoder()
  let finished = false
  try {
    for (;;) {
      armIdle()
      const { done, value } = await reader.read()
      disarmIdle()
      if (idleExpired) {
        throw new SseIdleTimeoutError(idleMs ?? 0)
      }
      if (done) {
        finished = true
        yield* decoder.push(textDecoder.decode())
        yield* decoder.end()
        return
      }
      yield* decoder.push(textDecoder.decode(value, { stream: true }))
    }
  } finally {
    disarmIdle()
    signal?.removeEventListener('abort', onAbort)
    if (!finished) {
      reader.cancel().catch(() => {})
    }
    reader.releaseLock()
  }
}
