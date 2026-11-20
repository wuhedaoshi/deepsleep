import { translate, type TranslationMessage } from '../../i18n/index.js'
import { readMessageEvent } from './parseEvent.js'
import { readServerSentEvents, SseIdleTimeoutError } from './sse.js'
import type {
  ApiErrorBody,
  CreateMessageRequest,
  FileObject,
  FilePurpose,
  MessageStreamEvent,
} from './types.js'

/** 构建期 API 地址，默认 https://api.deepseek.com；本地开发支持开发服务器代理 */
export const API_ORIGIN = __API_ORIGIN__
/** Anthropic 兼容接口的前缀 */
const ANTHROPIC_BASE_URL = `${API_ORIGIN}/anthropic/v1`
/** 引用 Files API 上传的图片、调用 Anthropic 兼容 Files API 时必须携带 */
const FILES_BETA = 'files-api-2025-04-14'

export type ApiErrorKind =
  /** 非 2xx 响应 */
  | 'http'
  /** 流中返回的错误帧（如等待生成超时），随后连接关闭 */
  | 'stream'
  /** 请求没有到达服务端（断网、跨域被拦截等） */
  | 'network'
  /** 请求发出但在超时时间内没有响应 */
  | 'timeout'
  /** 流在 message_stop 之前结束 */
  | 'interrupted'
  /** 响应不符合协议（如非 SSE 响应） */
  | 'protocol'

export class ApiError extends Error {
  readonly localMessage?: TranslationMessage

  constructor(
    readonly kind: ApiErrorKind,
    message: string | TranslationMessage,
    readonly status?: number
  ) {
    super(typeof message === 'string' ? message : translate(message.key, message.params))
    this.name = 'ApiError'
    this.localMessage = typeof message === 'string' ? undefined : message
  }
}

const isErrorBody = (value: unknown): value is ApiErrorBody =>
  typeof value === 'object' &&
  value !== null &&
  'error' in value &&
  typeof (value as ApiErrorBody).error?.message === 'string'

export type BodyReadOptions = {
  /** 调用方的取消信号：中止时取消读取并保留原因 */
  signal?: AbortSignal
  /** 读到这么多毫秒还没有结束就取消读取，返回已收到的部分 */
  timeoutMs?: number
  /** 只要前若干个字符（错误正文用），防止异常大的 body 占内存 */
  maxChars?: number
}

/**
 * 有界地读响应体。
 *
 * 为什么不能直接用 `response.text()`：响应头一到、body 却永远不结束时（网关 502 之后不关连接、
 * 代理挂住），`text()` 会一直挂着，调用方既拿不到 HTTP 状态也走不到错误分支。
 * 这里给「读取」本身设上限，并在退出路径上一定取消读取、解除监听、释放锁——
 * 无论读完、超时、用户取消还是提前返回，都不会留下挂在调用方 signal 上的监听。
 */
export const readBodyText = async (
  response: Response,
  options: BodyReadOptions = {}
): Promise<string> => {
  const { signal, timeoutMs, maxChars } = options
  if (response.body === null) {
    return ''
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const cancel = () => {
    reader.cancel(signal?.reason).catch(() => {})
  }
  // 已经取消的 signal 不会再发事件：必须自查，否则这次读取要等计时器才结束
  if (signal?.aborted) {
    cancel()
  } else {
    signal?.addEventListener('abort', cancel, { once: true })
  }
  const timer = timeoutMs === undefined ? undefined : setTimeout(cancel, timeoutMs)
  let text = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) {
        // 读到一半被取消：抛取消原因，别让调用方把「被中止」当成读到了空内容
        if (signal?.aborted) {
          throw signal.reason
        }
        return text + decoder.decode()
      }
      text += decoder.decode(value, { stream: true })
      if (maxChars !== undefined && text.length >= maxChars) {
        return text.slice(0, maxChars)
      }
    }
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer)
    }
    signal?.removeEventListener('abort', cancel)
    // 超时、取消、超长都走这里：先取消再解锁，连接不会因为「读了一半」被吊着
    cancel()
    reader.releaseLock()
  }
}

/** 非 2xx 与「协议不符」的响应体读取上限：读得到原因就够，不能让它把请求挂死 */
const ERROR_BODY_TIMEOUT_MS = 10_000
/** 错误正文只用于解析 message，超出部分没有价值 */
const MAX_ERROR_BODY_CHARS = 4_096

const readErrorResponse = async (
  response: Response,
  kind: 'http' | 'protocol' = 'http',
  fallback = response.statusText,
  signal?: AbortSignal,
  timeoutMs = ERROR_BODY_TIMEOUT_MS
): Promise<ApiError> => {
  let text = ''
  try {
    text = await readBodyText(response, { signal, timeoutMs, maxChars: MAX_ERROR_BODY_CHARS })
  } catch {
    // 正文读取本身失败（连接被重置、流报错）：状态码比正文重要得多，退回 statusText，
    // 别把 503 变成一个裸 TypeError——那样调用方既看不出是服务端故障，也拿不到状态码。
    if (signal?.aborted) {
      throw signal.reason
    }
    text = ''
  }
  // 没有走到读取路径的取消（null body 等）同样优先：把取消原样抛出去
  if (signal?.aborted) {
    throw signal.reason
  }
  let message = text || fallback
  try {
    const body: unknown = JSON.parse(text)
    if (isErrorBody(body)) {
      message = body.error.message
    }
  } catch {
    // 非 JSON 响应体（或读取被超时截断）直接展示原文
  }
  return new ApiError(kind, message, response.status)
}

/**
 * 等响应头的上限：移动端弱网，或切后台再回来时 TCP 已经是半开的，fetch 会一直挂起。
 * 只覆盖「请求发出 → 拿到响应头」，响应体由调用方自己读：流式回答可能持续几分钟，
 * 不能把它算进这个上限，否则正常长流会被自己的超时掐断。
 */
const RESPONSE_TIMEOUT_MS = 30_000

export type RequestOptions = {
  /** 等响应头的上限，默认 30 s */
  responseTimeoutMs?: number
  /** 非 2xx 响应体的读取上限，默认 10 s */
  errorBodyTimeoutMs?: number
}

/**
 * 发请求并等响应头；超时抛 `ApiError('timeout')`，调用方主动取消则原样抛取消原因。
 *
 * 两者必须分开：`store` 只有看到「signal 未中止」才会把失败记成错误，用户自己点停止
 * 却报一条超时，等于把主动操作说成故障。
 *
 * 合成 signal 用的是手工转发而不是 `AbortSignal.any()` / `AbortSignal.timeout()`：
 * 本项目的 WebView 下限比它们早得多（index.html 的垫片按 Chrome 92 起算，`any` 是 116、
 * `timeout` 是 103），直接调会在老机器上抛 TypeError。
 * 为了不把监听堆在调用方的 signal 上（同一个 signal 会被一次生成里的多次请求复用），
 * 转发只覆盖「等响应头」这一段，`finally` 里必定解除；响应体阶段的取消由各自的读取器负责。
 */
export const request = async (
  url: string,
  init: RequestInit,
  options: RequestOptions = {}
): Promise<Response> => {
  const caller = init.signal ?? undefined
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, options.responseTimeoutMs ?? RESPONSE_TIMEOUT_MS)
  // signal 已经中止时不会再发事件，必须自查；原因原样带进内部 controller，reason 不会丢
  const forwardAbort = () => controller.abort(caller?.reason)
  const listening = caller !== undefined && !caller.aborted
  if (caller?.aborted) {
    controller.abort(caller.reason)
  } else if (listening) {
    caller.addEventListener('abort', forwardAbort, { once: true })
  }
  let response: Response
  try {
    response = await fetch(url, { ...init, signal: controller.signal })
  } catch (error) {
    if (caller?.aborted) {
      throw error
    }
    if (timedOut) {
      throw new ApiError('timeout', { key: 'apiTimeout' })
    }
    throw new ApiError('network', error instanceof Error ? error.message : String(error))
  } finally {
    // 响应头到手就撤掉计时器与转发监听：此后读响应体再久也不算超时，signal 也不会累积监听
    clearTimeout(timer)
    if (listening) {
      caller.removeEventListener('abort', forwardAbort)
    }
  }
  if (!response.ok) {
    throw await readErrorResponse(
      response,
      'http',
      response.statusText,
      caller,
      options.errorBodyTimeoutMs
    )
  }
  return response
}

const anthropicHeaders = (apiKey: string, beta: boolean): Record<string, string> => ({
  // DeepSeek 兼容接口的鉴权方式，也可使用 Authorization: Bearer。
  'x-api-key': apiKey,
  // Files API 和通过 file_id 引用图片时必传；纯文本聊天无需携带。
  ...(beta ? { 'anthropic-beta': FILES_BETA } : {}),
})

/** 用 GET /models 校验 API Key（不产生费用） */
/** 校验 Key 的超时：真机上出现过 37 秒才报 Failed to fetch，用户一直盯着「验证中…」 */
const VERIFY_TIMEOUT_MS = 15_000

export const verifyApiKey = async (apiKey: string, signal?: AbortSignal): Promise<void> => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), VERIFY_TIMEOUT_MS)
  // 外部传入的取消信号也要能打断这次校验
  const forwardAbort = () => controller.abort()
  signal?.addEventListener('abort', forwardAbort, { once: true })
  try {
    await request(`${API_ORIGIN}/models`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
    })
  } catch (error) {
    // 超时被 abort：给一个说得清的错，而不是裸的 AbortError
    if (controller.signal.aborted && !signal?.aborted) {
      throw new ApiError('timeout', 'verify timed out')
    }
    throw error
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', forwardAbort)
  }
}

/**
 * 上传附件。
 *
 * 两段都要有超时：请求阶段（等响应头）与读取阶段（拿 file_id 的 JSON）。
 * 少了超时，一条卡住的请求会让附件永远停在 `uploading`，发送键一直灰着——
 * 用户看到的就是「选了图没反应」。用户主动取消仍然优先（外部 signal 直接打断）。
 */
const UPLOAD_TIMEOUT_MS = 120_000

export const uploadFile = async (
  apiKey: string,
  file: File,
  purpose: FilePurpose | null,
  signal?: AbortSignal
): Promise<FileObject> => {
  const form = new FormData()
  if (purpose) {
    form.append('purpose', purpose)
  }
  form.append('file', file)
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, UPLOAD_TIMEOUT_MS)
  const forwardAbort = () => controller.abort()
  signal?.addEventListener('abort', forwardAbort, { once: true })
  // 注册监听前外部信号可能已经中止（例如用户在图片归一化期间取消）：
  // 那时不会再收到 abort 事件，必须立刻自查，否则仍会把 POST 发出去。
  if (signal?.aborted) {
    controller.abort()
  }
  try {
    const response = await request(
      `${ANTHROPIC_BASE_URL}/files`,
      {
        method: 'POST',
        headers: anthropicHeaders(apiKey, true),
        body: form,
        signal: controller.signal,
      },
      // 上传大图时「请求发出→响应头」本身就可能超过通用上限，这里沿用上传自己的预算
      { responseTimeoutMs: UPLOAD_TIMEOUT_MS, errorBodyTimeoutMs: UPLOAD_TIMEOUT_MS }
    )
    // 响应体读取同样受这段超时覆盖：request 只等到响应头，正文由这里带着同一个 signal 读，
    // 所以「拿了 file_id 的 JSON 却不结束」也会在上传预算到点时被打断。
    return JSON.parse(await readBodyText(response, { signal: controller.signal })) as FileObject
  } catch (error) {
    if (timedOut && !signal?.aborted) {
      throw new ApiError('timeout', 'upload timed out')
    }
    throw error
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', forwardAbort)
  }
}

/** DELETE /anthropic/v1/files/{file_id} */
export const deleteFile = async (apiKey: string, fileId: string): Promise<void> => {
  await request(`${ANTHROPIC_BASE_URL}/files/${encodeURIComponent(fileId)}`, {
    method: 'DELETE',
    headers: anthropicHeaders(apiKey, true),
  })
}

const hasFile = (body: CreateMessageRequest) =>
  body.messages.some(
    (message) =>
      typeof message.content !== 'string' &&
      message.content.some((block) => block.type === 'image' || block.type === 'document')
  )

/**
 * 服务端「连着但不再给数据」的判据：生成期间增量帧是连续来的，正常长流每收到一段就续期，
 * 只有连接半开才会长时间一个字节都没有。给得比正常帧间隔宽松得多，免得误伤慢模型。
 */
const STREAM_IDLE_TIMEOUT_MS = 90_000

export type StreamOptions = {
  /** 覆盖每次读取的空闲上限；只给测试与特殊链路用，正常调用走默认值 */
  idleTimeoutMs?: number
  /** 覆盖「非 SSE 响应体」的读取上限，同 idleTimeoutMs 的用途 */
  errorBodyTimeoutMs?: number
}

/**
 * POST /anthropic/v1/messages（stream: true），逐个产出流式事件，收到 message_stop 时结束。
 * ping、保活注释与无法解析的内容不产出；中止请求时抛出 signal 的 AbortError。
 * 连接长时间没有任何字节时抛 `ApiError('timeout')`：不自动重放，由调用方决定怎么收尾。
 */
export async function* streamMessage(
  apiKey: string,
  body: CreateMessageRequest,
  signal: AbortSignal,
  options: StreamOptions = {}
): AsyncGenerator<MessageStreamEvent> {
  const response = await request(`${ANTHROPIC_BASE_URL}/messages`, {
    method: 'POST',
    headers: {
      ...anthropicHeaders(apiKey, hasFile(body)),
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    },
    body: JSON.stringify({ ...body, stream: true }),
    signal,
  })
  const contentType = response.headers.get('Content-Type') ?? ''
  if (!response.body || !contentType.includes('text/event-stream')) {
    // 非 SSE 响应同样可能「头到了、body 不结束」（网关返回一段 HTML 就挂住）：
    // 这里的读取必须有界，否则整条流式链路会卡在拿不到协议错误上。
    throw await readErrorResponse(response, 'protocol', '', signal, options.errorBodyTimeoutMs)
  }
  try {
    for await (const { event: eventName, data } of readServerSentEvents(
      response.body,
      signal,
      options.idleTimeoutMs ?? STREAM_IDLE_TIMEOUT_MS
    )) {
      let payload: unknown
      try {
        payload = JSON.parse(data)
      } catch {
        if (eventName !== 'error') {
          continue
        }
      }
      if (isErrorBody(payload)) {
        throw new ApiError('stream', payload.error.message)
      }
      if (eventName === 'error') {
        throw new ApiError('stream', data)
      }
      const event = readMessageEvent(payload)
      if (!event) {
        continue
      }
      yield event
      if (event.type === 'message_stop') {
        return
      }
    }
  } catch (error) {
    // 用户先按了停止：那是用户要的结果，不能报成超时（store 靠 signal.aborted 区分）
    if (error instanceof SseIdleTimeoutError && !signal.aborted) {
      throw new ApiError('timeout', { key: 'apiTimeout' })
    }
    throw error
  }
  // 服务端没有提供错误内容时保持为空，不推测断流原因。
  throw new ApiError('interrupted', '')
}
