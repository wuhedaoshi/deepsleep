import { logInfo } from '../log.js'
import { ApiError, readBodyText, request } from './client.js'
import { bearer, openCodeProtocol, siliconFlowEfforts, type Connection } from './connections.js'
import { readMessageEvent } from './parseEvent.js'
import { readServerSentEvents, SseIdleTimeoutError } from './sse.js'
import type { CreateMessageRequest, MessageStreamEvent, MessageUsage, StopReason } from './types.js'

const stopReason = (reason: string): StopReason => {
  if (reason === 'length') {
    return 'max_tokens'
  }
  if (reason === 'content_filter') {
    return 'refusal'
  }
  if (reason === 'tool_calls') {
    return 'tool_use'
  }
  return 'end_turn'
}

export async function* streamCompatibleChat(
  connection: Connection,
  body: CreateMessageRequest,
  signal: AbortSignal
): AsyncGenerator<MessageStreamEvent> {
  const messages = [{ role: 'system', content: body.system }]
  for (const message of body.messages) {
    if (message.role === 'latest_reminder') {
      continue
    }
    const content =
      typeof message.content === 'string'
        ? message.content
        : message.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('\n')
    if (content.trim()) {
      messages.push({ role: message.role, content })
    }
  }
  if (messages.at(-1)?.role === 'assistant') {
    messages.push({
      role: 'user',
      content: 'Continue the preceding answer from where it stopped. Do not repeat it.',
    })
  }
  const bridge = (globalThis as { __deepsleepNative?: { getOpenCodeNonce?: () => string } })
    .__deepsleepNative
  const nonce = connection.provider === 'opencode' ? bridge?.getOpenCodeNonce?.() : undefined
  const openCode = connection.provider === 'opencode'
  const protocol = openCode
    ? (connection.protocol ?? openCodeProtocol(connection.model))
    : 'chat-completions'
  const endpoint =
    protocol === 'messages'
      ? nonce
        ? '/api/opencode/messages'
        : 'https://opencode.ai/inference/anthropic/v1/messages'
      : protocol === 'responses'
        ? nonce
          ? '/api/opencode/responses'
          : connection.base + '/responses'
        : nonce
          ? '/api/opencode/chat'
          : connection.base + '/chat/completions'
  const effort = connection.effort
  logInfo('chat', '兼容聊天请求路由', { provider: connection.provider, protocol, effort })
  const requestBody =
    protocol === 'responses'
      ? {
          model: connection.model,
          input: messages,
          ...(body.max_tokens ? { max_output_tokens: body.max_tokens } : {}),
          stream: true,
          ...(effort ? { reasoning: { effort } } : {}),
        }
      : protocol === 'messages'
        ? {
            model: connection.model,
            system: body.system,
            messages: messages.slice(1),
            max_tokens: body.max_tokens ?? 4096,
            stream: true,
          }
        : {
            model: connection.model,
            messages,
            stream: true,
            ...(openCode
              ? { stream_options: { include_usage: true }, max_tokens: body.max_tokens }
              : {}),
            ...(effort &&
            (openCode ||
              (connection.provider === 'siliconflow' &&
                siliconFlowEfforts(connection.model).includes(effort)))
              ? {
                  reasoning_effort: effort,
                  ...(connection.provider === 'siliconflow' ? { enable_thinking: true } : {}),
                }
              : {}),
          }
  const response = await request(endpoint, {
    method: 'POST',
    headers: {
      ...bearer(connection.key),
      ...(nonce ? { 'X-Deepsleep-OpenCode': nonce } : {}),
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      ...(protocol === 'messages' ? { 'anthropic-version': '2023-06-01' } : {}),
    },
    redirect: 'error',
    body: JSON.stringify(requestBody),
    signal,
  })
  if (!response.body || !response.headers.get('Content-Type')?.includes('text/event-stream')) {
    throw new ApiError(
      'protocol',
      await readBodyText(response, { signal, timeoutMs: 3000, maxChars: 1000 })
    )
  }
  const opened = new Set<number>()
  let started = false
  let reason: StopReason | undefined
  let usage: MessageUsage | undefined
  let responseId = ''
  try {
    for await (const { data } of readServerSentEvents(response.body, signal, 60_000)) {
      if (data === '[DONE]') {
        break
      }
      let chunk
      try {
        chunk = JSON.parse(data)
      } catch {
        continue
      }
      if (typeof chunk?.error?.message === 'string') {
        throw new ApiError('stream', chunk.error.message)
      }
      if (protocol === 'messages') {
        const event = readMessageEvent(chunk)
        if (event) {
          yield event
          if (event.type === 'message_stop') {
            return
          }
        }
        continue
      }
      const choice = chunk?.choices?.[0]
      if (protocol === 'responses') {
        if (typeof chunk?.response?.id === 'string') {
          responseId = chunk.response.id
        }
        if (chunk?.type === 'response.failed' || chunk?.type === 'error') {
          const error = chunk.response?.error ?? chunk
          throw new ApiError('stream', typeof error.message === 'string' ? error.message : '')
        }
        if (chunk?.type === 'response.completed' || chunk?.type === 'response.incomplete') {
          usage = normalizeUsage(chunk.response?.usage)
          reason =
            chunk.type === 'response.completed'
              ? 'end_turn'
              : chunk.response?.incomplete_details?.reason === 'content_filter'
                ? 'refusal'
                : 'max_tokens'
          break
        }
      } else {
        usage = normalizeUsage(chunk?.usage) ?? usage
        if (!choice) {
          continue
        }
      }
      const reasoning =
        protocol === 'responses'
          ? chunk?.type === 'response.reasoning_summary_text.delta'
            ? chunk.delta
            : undefined
          : (choice.delta?.reasoning_content ?? choice.delta?.reasoning)
      const content =
        protocol === 'responses'
          ? chunk?.type === 'response.output_text.delta' || chunk?.type === 'response.refusal.delta'
            ? chunk.delta
            : undefined
          : choice.delta?.content
      if (!started && (typeof content === 'string' || typeof reasoning === 'string' || choice)) {
        started = true
        yield {
          type: 'message_start',
          message: {
            id: typeof chunk.id === 'string' ? chunk.id : responseId,
            model: connection.model,
          },
        }
      }
      if (typeof reasoning === 'string' && reasoning) {
        if (!opened.has(0)) {
          opened.add(0)
          yield {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'thinking', thinking: '', signature: '' },
          }
        }
        yield {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'thinking_delta', thinking: reasoning },
        }
      }
      if (typeof content === 'string' && content) {
        if (!opened.has(1)) {
          opened.add(1)
          yield { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }
        }
        yield {
          type: 'content_block_delta',
          index: 1,
          delta: { type: 'text_delta', text: content },
        }
      }
      if (typeof choice?.finish_reason === 'string') {
        reason = stopReason(choice.finish_reason)
        if (!openCode) {
          break
        }
      }
    }
  } catch (error) {
    if (!(error instanceof SseIdleTimeoutError) || signal.aborted) {
      throw error
    }
    if (!reason) {
      throw new ApiError('timeout', { key: 'apiTimeout' })
    }
  }
  if (!reason) {
    throw new ApiError('interrupted', '')
  }
  for (const index of opened) {
    yield { type: 'content_block_stop', index }
  }
  yield { type: 'message_delta', delta: { stop_reason: reason, stop_sequence: null }, usage }
  yield { type: 'message_stop' }
}

const normalizeUsage = (
  value:
    | {
        prompt_tokens?: number
        completion_tokens?: number
        input_tokens?: number
        output_tokens?: number
        prompt_tokens_details?: { cached_tokens?: number }
        input_tokens_details?: { cached_tokens?: number }
      }
    | null
    | undefined
): MessageUsage | undefined => {
  const input = value?.prompt_tokens ?? value?.input_tokens
  const output = value?.completion_tokens ?? value?.output_tokens
  if (
    typeof input !== 'number' ||
    typeof output !== 'number' ||
    !Number.isFinite(input) ||
    !Number.isFinite(output) ||
    input < 0 ||
    output < 0
  ) {
    return undefined
  }
  const cached =
    value?.prompt_tokens_details?.cached_tokens ?? value?.input_tokens_details?.cached_tokens
  const cache =
    typeof cached === 'number' && Number.isFinite(cached) ? Math.min(input, Math.max(0, cached)) : 0
  return {
    input_tokens: input - cache,
    cache_read_input_tokens: cache,
    cache_creation_input_tokens: 0,
    output_tokens: output,
  }
}
