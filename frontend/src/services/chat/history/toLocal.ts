/**
 * 归档里的单个会话 JSON → 本地 `Session`。
 *
 * 两种来源：
 * - `official`：DeepSeek 导出的 `export_format_version: 3`，消息是 `fragments` 数组，
 *   分支靠 `parent_id` + `current_message_id` 表达；
 * - `local`：本应用 1.2.6 起导出的 `version: 4`，会话 JSON 就是本地结构，往返无损。
 *
 * 容错口径：字段缺失或结构损坏抛 `BackupError`，由调用方跳过该会话并计数，
 * 不因为一个坏会话让整包导入失败。
 */
import type {
  ServerToolBlock,
  ServerToolKind,
  ServerToolInput,
  WebFetchResult,
  WebFetchToolResultBlock,
  WebSearchResult,
} from '../../api/types.js'
import type {
  AssistantMessage,
  FileAttachment,
  Message,
  ReplyBlock,
  ReplyStatus,
  Session,
  UserMessage,
} from '../types.js'
import { BackupError } from './errors.js'

type Json = Record<string, unknown>

export type ArchiveFormat = 'official' | 'local'

const fail = (): never => {
  throw new BackupError('backupIncomplete')
}

const object = (value: unknown): Json | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Json) : null

const needObject = (value: unknown): Json => object(value) ?? fail()

const text = (value: unknown): string => (typeof value === 'string' ? value : fail())

const optionalText = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined

const count = (value: unknown): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    return fail()
  }
  return value
}

const flag = (value: unknown): boolean => (typeof value === 'boolean' ? value : fail())

/** 归档里的时间只接受 `YYYY-MM-DDTHH:mm:ss(.sss)?Z`，先对齐到毫秒再交给 `Date`。 */
const instant = (value: unknown): number => {
  if (typeof value !== 'string') {
    return fail()
  }
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?Z$/.exec(value)
  if (!match) {
    return fail()
  }
  const normalized = `${match[1]}.${(match[2] ?? '').padEnd(3, '0').slice(0, 3)}Z`
  const parsed = Date.parse(normalized)
  return Number.isFinite(parsed) ? parsed : fail()
}

const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])

const isWebUrl = (value: string): boolean => {
  try {
    const { protocol } = new URL(value)
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}

// ---------- 官方导出：fragment → 内容块 ----------

const webSearchResult = (value: unknown): WebSearchResult => {
  const item = needObject(value)
  const siteIcon = optionalText(item.site_icon)
  return {
    type: 'web_search_result',
    url: text(item.url),
    title: text(item.title),
    snippet: text(item.snippet),
    site_icon: siteIcon !== undefined && isWebUrl(siteIcon) ? siteIcon : null,
    site_name: optionalText(item.site_name) ?? null,
    page_age: optionalText(item.published_at) ?? null,
    encrypted_content: '',
  }
}

const attachment = (value: unknown): FileAttachment => {
  const item = needObject(value)
  return {
    id: text(item.id),
    serverId: null,
    name: text(item.file_name),
    size: count(item.file_size),
    isImage: flag(item.is_image),
    mimeType: '',
  }
}

const serverToolUse = (
  id: string,
  input: ServerToolInput,
  kind: ServerToolKind,
  result?: ServerToolBlock
): ServerToolBlock[] => {
  const use: ServerToolBlock = {
    type: 'server_tool_use',
    id,
    name: kind === 'read_link' ? 'deepseek_read_url' : 'deepseek_web_search',
    input,
    kind,
    caller: { type: 'direct' },
  }
  return result === undefined ? [use] : [use, result]
}

const fetchedDocument = (
  url: string,
  title: string | null,
  publishedAt: string | null
): WebFetchResult => ({
  type: 'web_fetch_result',
  url,
  content: {
    type: 'document',
    source: { type: 'text', media_type: 'text/plain', data: '' },
    title,
  },
  published_at: publishedAt,
})

const fetchResult = (
  id: string,
  kind: 'read_link' | 'deep_search',
  content: WebFetchToolResultBlock['content'],
  signature?: string
): WebFetchToolResultBlock => ({
  type: 'web_fetch_tool_result',
  tool_use_id: id,
  kind,
  content,
  ...(signature === undefined ? {} : { signature }),
})

/**
 * 工具类 fragment → `server_tool_use` + 结果块。
 * `status` 为 `WIP` 时只写调用块：结果还没回来，补一个空结果会被服务端当成失败。
 */
const toolBlocks = (
  fragment: Json,
  index: number,
  messageId: string,
  searchKind: ServerToolKind
): ServerToolBlock[] => {
  const id = `history-${messageId}-${index}`
  const status = optionalText(fragment.status)
  const finished = status === 'FINISHED'
  const pending = status === 'WIP'
  const unavailable = fetchResult(id, 'deep_search', {
    type: 'web_fetch_tool_result_error',
    error_code: 'unavailable',
  })
  switch (optionalText(fragment.type)) {
    case 'TOOL_SEARCH': {
      const queries = list(fragment.queries).map((query) => text(query))
      const result: ServerToolBlock = {
        type: 'web_search_tool_result',
        tool_use_id: id,
        kind: searchKind === 'read_link' ? 'search' : searchKind,
        content:
          status === 'FAILED'
            ? [{ type: 'web_search_tool_result_error', error_code: 'unavailable' }]
            : list(fragment.results).map(webSearchResult).filter((hit) => isWebUrl(hit.url)),
      }
      return serverToolUse(
        id,
        { action: 'search', query: queries[0] ?? '', queries },
        searchKind,
        pending ? undefined : result
      )
    }
    case 'TOOL_OPEN': {
      const url = optionalText(fragment.url) ?? ''
      if (!isWebUrl(url)) {
        return []
      }
      const title = optionalText(fragment.title)
      const publishedAt = optionalText(fragment.published_at)
      const result = finished
        ? fetchResult(
            id,
            'deep_search',
            fetchedDocument(url, title === undefined ? null : title, publishedAt === undefined ? null : publishedAt)
          )
        : unavailable
      return serverToolUse(
        id,
        { action: 'open_page', url },
        'deep_search',
        pending ? undefined : result
      )
    }
    case 'TOOL_FIND': {
      const pattern = optionalText(fragment.pattern) ?? ''
      const result = finished
        ? fetchResult(id, 'deep_search', fetchedDocument('', null, null))
        : unavailable
      return serverToolUse(
        id,
        { action: 'find_in_page', url: '', pattern },
        'deep_search',
        pending ? undefined : result
      )
    }
    case 'READ_LINK': {
      const blocks: ServerToolBlock[] = []
      list(fragment.results).forEach((raw, at) => {
        const item = needObject(raw)
        const url = optionalText(item.url) ?? ''
        const signature = optionalText(item.signature) ?? ''
        const target = isWebUrl(url) ? url : ''
        if (target === '' && signature.trim() === '') {
          return
        }
        const linkId = `${id}-${at}`
        const title = optionalText(item.title)
        blocks.push(
          ...serverToolUse(
            linkId,
            { action: 'read_link', url: target },
            'read_link',
            fetchResult(
              linkId,
              'read_link',
              fetchedDocument(target, title === undefined ? null : title, null),
              signature
            )
          )
        )
      })
      return blocks
    }
    default:
      return []
  }
}

/** 出现过打开页面 / 页内查找的会话按「边想边搜」归类，否则只算文字搜索。 */
const searchKindOf = (fragments: readonly Json[]): ServerToolKind =>
  fragments.some(
    (fragment) => fragment.type === 'TOOL_OPEN' || fragment.type === 'TOOL_FIND'
  )
    ? 'deep_search'
    : 'search'

const replyBlocks = (fragments: readonly Json[], messageId: string): ReplyBlock[] => {
  const searchKind = searchKindOf(fragments)
  const blocks: ReplyBlock[] = []
  fragments.forEach((fragment, index) => {
    switch (optionalText(fragment.type)) {
      case 'RESPONSE':
        blocks.push({ type: 'text', text: text(fragment.content) })
        return
      case 'TEMPLATE_RESPONSE':
        blocks.push({ type: 'text', text: text(fragment.content), isTemplate: true })
        return
      case 'THINK': {
        const elapsed = fragment.elapsed_secs
        blocks.push({
          type: 'thinking',
          thinking: text(fragment.content),
          ...(typeof elapsed === 'number' && Number.isFinite(elapsed)
            ? { elapsedSeconds: elapsed }
            : {}),
        })
        return
      }
      default:
        blocks.push(...toolBlocks(fragment, index, messageId, searchKind))
    }
  })
  return blocks
}

const STATUS_BY_ARCHIVE: Record<string, ReplyStatus> = {
  FINISHED: 'done',
  CONTENT_FILTER: 'done',
  FAILED: 'error',
  CONTEXT_LENGTH_EXCEEDED: 'error',
  TIMEOUT: 'error',
  INCOMPLETE: 'stopped',
  WIP: 'stopped',
}

type RawMessage = {
  id: string
  parentId: string | null
  role: 'USER' | 'ASSISTANT'
  json: Json
  fragments: Json[]
}

const rawMessage = (value: unknown): RawMessage => {
  const json = needObject(value)
  const role = optionalText(json.role)
  if (role !== 'USER' && role !== 'ASSISTANT') {
    return fail()
  }
  const parent = json.parent_id
  if (parent !== null && parent !== undefined && typeof parent !== 'number' && typeof parent !== 'string') {
    return fail()
  }
  const status = optionalText(json.status)
  if (status === undefined || STATUS_BY_ARCHIVE[status] === undefined) {
    return fail()
  }
  return {
    id: String(json.id),
    parentId: parent === null || parent === undefined ? null : String(parent),
    role,
    json,
    fragments: list(json.fragments).map(needObject),
  }
}

/** 沿 `current_message_id` 上溯取当前分支；结构的任何不一致都按损坏处理。 */
const currentBranch = (messages: readonly RawMessage[], currentId: unknown): RawMessage[] => {
  if (messages.length === 0) {
    return []
  }
  const byId = new Map<string, RawMessage>()
  for (const message of messages) {
    if (byId.has(message.id)) {
      return fail()
    }
    byId.set(message.id, message)
  }
  const startId =
    typeof currentId === 'number' || typeof currentId === 'string'
      ? String(currentId)
      : messages[messages.length - 1].id
  let cursor: RawMessage | undefined = byId.get(startId)
  if (!cursor) {
    return fail()
  }
  const branch: RawMessage[] = []
  const seen = new Set<string>()
  while (cursor) {
    if (seen.has(cursor.id)) {
      return fail()
    }
    seen.add(cursor.id)
    branch.push(cursor)
    cursor = cursor.parentId === null ? undefined : byId.get(cursor.parentId) ?? fail()
  }
  branch.reverse()
  if (branch[0].role !== 'USER') {
    return fail()
  }
  for (let index = 1; index < branch.length; index += 1) {
    if (branch[index].role === branch[index - 1].role) {
      return fail()
    }
  }
  return branch
}

const toUserMessage = (raw: RawMessage, mimeTypeOf: (fileId: string) => string): UserMessage => {
  const files = raw.fragments.flatMap((fragment) =>
    fragment.type === 'FILE' ? list(fragment.files).map(attachment) : []
  )
  return {
    id: raw.id,
    role: 'user',
    createdAt: instant(raw.json.inserted_at),
    content: raw.fragments
      .map((fragment) => (fragment.type === 'REQUEST' ? text(fragment.content) : ''))
      .join(''),
    files: files.map((file) => ({ ...file, mimeType: mimeTypeOf(file.id) })),
  }
}

const toAssistantMessage = (raw: RawMessage): AssistantMessage => {
  const status = optionalText(raw.json.status) ?? fail()
  const blocks = replyBlocks(raw.fragments, raw.id)
  const filtered = status === 'CONTENT_FILTER'
  const kept = filtered
    ? blocks.filter(
        (block) => block.type !== 'thinking' && (block.type !== 'text' || block.isTemplate === true)
      )
    : blocks
  return {
    id: raw.id,
    role: 'assistant',
    createdAt: instant(raw.json.inserted_at),
    model: null,
    thinking: flag(raw.json.thinking_enabled),
    search: flag(raw.json.search_enabled),
    prefix: false,
    status: STATUS_BY_ARCHIVE[status] ?? fail(),
    ...(filtered ? { stopReason: 'refusal' as const } : {}),
    blocks: kept,
  }
}

/** 官方格式：整包会话 JSON → 本地会话（不含置顶，置顶来自索引）。 */
const officialSession = (
  raw: unknown,
  mimeTypeOf: (fileId: string) => string
): Session => {
  const json = needObject(raw)
  const messages = list(json.messages).map(rawMessage)
  const branch = currentBranch(messages, json.current_message_id)
  const converted: Message[] = []
  let previous: Message | undefined
  for (const item of branch) {
    const message: Message =
      item.role === 'USER' ? toUserMessage(item, mimeTypeOf) : toAssistantMessage(item)
    if (previous) {
      previous.selectedChildId = message.id
      message.parentId = previous.id
    } else {
      message.parentId = null
    }
    converted.push(message)
    previous = message
  }
  if (previous) {
    previous.selectedChildId = undefined
  }
  return {
    id: text(json.id),
    title: optionalText(json.title) ?? '',
    createdAt: instant(json.inserted_at),
    updatedAt: instant(json.updated_at),
    messages: converted,
    rootMessageId: converted.length === 0 ? null : converted[0].id,
  }
}

/** 本地格式：会话 JSON 就是本地结构，只做最低限度的形状校验。 */
const localSession = (raw: unknown): Session => {
  const json = needObject(raw)
  const messages = list(json.messages).map((value) => {
    const message = needObject(value)
    const role = optionalText(message.role)
    if (role !== 'user' && role !== 'assistant') {
      return fail()
    }
    return message as unknown as Message
  })
  const root = json.rootMessageId
  return {
    id: text(json.id),
    title: optionalText(json.title) ?? '',
    createdAt: count(json.createdAt),
    updatedAt: count(json.updatedAt),
    messages,
    ...(root === undefined || root === null ? {} : { rootMessageId: String(root) }),
  }
}

/**
 * 把归档里的一个会话 JSON 转成本地会话。
 * `mimeTypeOf` 由归档的附件清单提供，为空的附件仍保留文件名，只是不能预览。
 */
export const sessionFromArchive = (
  raw: unknown,
  format: ArchiveFormat,
  mimeTypeOf: (fileId: string) => string
): Session =>
  format === 'local' ? localSession(raw) : officialSession(raw, mimeTypeOf)
