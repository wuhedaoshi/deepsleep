import { ApiError, readBodyText, request } from './client.js'
import { bearer, type Connection } from './connections.js'
import { readServerSentEvents, SseIdleTimeoutError } from './sse.js'
import type { CreateMessageRequest, MessageStreamEvent, StopReason } from './types.js'

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
  const endpoint = nonce ? '/api/opencode/chat' : connection.base + '/chat/completions'
  const response = await request(endpoint, {
    method: 'POST',
    headers: {
      ...bearer(connection.key),
      ...(nonce ? { 'X-Deepsleep-OpenCode': nonce } : {}),
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    },
    redirect: 'error',
    body: JSON.stringify({ model: connection.model, messages, stream: true }),
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
      const choice = chunk?.choices?.[0]
      if (!choice) {
        continue
      }
      if (!started) {
        started = true
        yield {
          type: 'message_start',
          message: { id: typeof chunk.id === 'string' ? chunk.id : '', model: connection.model },
        }
      }
      const reasoning = choice.delta?.reasoning_content ?? choice.delta?.reasoning
      const content = choice.delta?.content
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
      if (typeof choice.finish_reason === 'string') {
        reason = stopReason(choice.finish_reason)
        break
      }
    }
  } catch (error) {
    if (error instanceof SseIdleTimeoutError && !signal.aborted) {
      throw new ApiError('timeout', { key: 'apiTimeout' })
    }
    throw error
  }
  if (!reason) {
    throw new ApiError('interrupted', '')
  }
  for (const index of opened) {
    yield { type: 'content_block_stop', index }
  }
  yield { type: 'message_delta', delta: { stop_reason: reason, stop_sequence: null } }
  yield { type: 'message_stop' }
}
