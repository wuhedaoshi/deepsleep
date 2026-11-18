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


/**
 * 把官方 v3 的消息列表还原成**完整分支树**。
 *
 * 为什么不能只取当前分支：官方归档里 `parent_id` 表达了所有分支，
 * 而 `current_message_id` 只标出"用户停在哪"。只沿当前路径导入，等于把
 * 其它分支（重新生成产生的兄弟消息）全部丢掉——导入后无法再切分支。
 *
 * 规则（与官方 chat-demo 一致）：
 * - 每条消息的 parentId 指向其父；父子角色必须交替，根必须是 USER
 * - 沿 current_message_id 上溯，把路径上每个祖先的 selectedChildId 指向路径子节点
 * - 其它节点的 selectedChildId 保留最后处理的子消息（存档按 id 升序，效果等于选最大 id）
 */
const buildTree = (
  messages: readonly RawMessage[],
  currentId: unknown,
  mimeTypeOf: (fileId: string) => string
): { messages: Message[]; rootMessageId: string | null } => {
  if (messages.length === 0) {
    return { messages: [], rootMessageId: null }
  }
  const byId = new Map<string, RawMessage>()
  for (const message of messages) {
    if (byId.has(message.id)) {
      return fail()
    }
    byId.set(message.id, message)
  }
  for (const message of messages) {
    if (message.parentId !== null && !byId.has(message.parentId)) {
      return fail()
    }
  }

  // 环检测：迭代标记，每节点最多访问一次（逐节点上溯最坏是 O(n²)）
  const state = new Map<string, number>()
  for (const message of messages) {
    if (state.get(message.id) === 2) {
      continue
    }
    const path: string[] = []
    let cursor: RawMessage | undefined = message
    while (cursor) {
      const seen = state.get(cursor.id)
      if (seen === 2) {
        break
      }
      if (seen === 1) {
        return fail()
      }
      state.set(cursor.id, 1)
      path.push(cursor.id)
      const parentId: string | null | undefined = cursor.parentId
      cursor = parentId === null || parentId === undefined ? undefined : byId.get(parentId)
    }
    for (const id of path) {
      state.set(id, 2)
    }
  }

  // 迭代式拓扑转换：先父后子，深链不会爆栈
  const childrenOf = new Map<string, RawMessage[]>()
  const roots: RawMessage[] = []
  for (const message of messages) {
    const parentId = message.parentId
    if (parentId === null || parentId === undefined) {
      roots.push(message)
      continue
    }
    const siblings = childrenOf.get(parentId)
    if (siblings) {
      siblings.push(message)
    } else {
      childrenOf.set(parentId, [message])
    }
  }
  // 所有根都必须是 USER（官方约束），不能只查第一个
  for (const root of roots) {
    if (root.role !== 'USER') {
      return fail()
    }
  }
  const converted = new Map<string, Message>()
  const ordered: Message[] = []
  const queue: RawMessage[] = [...roots]
  let head = 0
  while (head < queue.length) {
    const raw = queue[head]
    head += 1
    const parentId = raw.parentId
    const hasParent = parentId !== null && parentId !== undefined
    const parent = hasParent ? converted.get(parentId) : undefined
    if (hasParent) {
      if (!parent) {
        return fail()
      }
      if (byId.get(parentId as string)?.role === raw.role) {
        return fail()
      }
    }
    const message: Message =
      raw.role === 'USER' ? toUserMessage(raw, mimeTypeOf) : toAssistantMessage(raw)
    message.parentId = hasParent ? parentId : null
    converted.set(raw.id, message)
    ordered.push(message)
    for (const child of childrenOf.get(raw.id) ?? []) {
      queue.push(child)
    }
  }
  if (ordered.length !== messages.length) {
    return fail()
  }

  // 默认选中同父下 id 最大者（与官方一致，不依赖数组顺序）
  for (const message of ordered) {
    const parentId = message.parentId
    if (parentId === null || parentId === undefined) {
      continue
    }
    const parent = converted.get(parentId)
    if (!parent) {
      return fail()
    }
    const selected = parent.selectedChildId
    if (selected === undefined || compareIds(message.id, selected) > 0) {
      parent.selectedChildId = message.id
    }
  }

  // 用户停留位置：沿 current_message_id 上溯，覆盖路径上的 selectedChildId
  // 缺 current_message_id 时不能取数组最后一项（顺序不保证），显式选 id 最大者
  const fallbackId = messages.reduce(
    (best, message) => (compareIds(message.id, best) > 0 ? message.id : best),
    messages[0].id
  )
  const startId =
    typeof currentId === 'number' || typeof currentId === 'string'
      ? String(currentId)
      : converted.has(fallbackId)
        ? fallbackId
        : (roots[0]?.id ?? '')
  let cursor: Message = converted.get(startId) ?? fail()
  cursor.selectedChildId = undefined
  const pathSeen = new Set<string>()
  for (;;) {
      const parentId: string | null | undefined = cursor.parentId
    if (parentId === null || parentId === undefined) {
      break
    }
    if (pathSeen.has(cursor.id)) {
      return fail()
    }
    pathSeen.add(cursor.id)
    const parent: Message = converted.get(parentId) ?? fail()
    parent.selectedChildId = cursor.id
    cursor = parent
  }
  return { messages: ordered, rootMessageId: cursor.id }
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
    // 与回答同理：FILE 条目的 width/height、token_usage 等字段本地不建模，
    // 不留存就会在导出时被重建成 null（官方图床信息就丢了）
    archivedFragments: raw.fragments,
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
    // 原样保留官方片段：本地块模型覆盖不到的类型（TIP / CONTENT_RISK /
    // PARTIAL_FILE_READ / TOOL_IMAGE_SEARCH）与字段（工具状态、snippet、stage_id）导出时要能还回去
    archivedFragments: raw.fragments,
  }
}

/** 官方格式：整包会话 JSON → 本地会话（不含置顶，置顶来自索引）。 */
const officialSession = (
  raw: unknown,
  mimeTypeOf: (fileId: string) => string
): Session => {
  const json = needObject(raw)
  const messages = list(json.messages).map(rawMessage)
  // 导入**全部**消息并建树：只取当前分支会把其它分支丢掉，导入后无法切换。
  // 规则与官方一致：parent_id 连父子；沿 current_message_id 上溯的路径写 selectedChildId；
  // 其余节点的 selectedChildId 保留「最后处理的子消息」（存档按 id 升序，等于选的最大 id）。
  const tree = buildTree(messages, json.current_message_id, mimeTypeOf)
  return {
    id: text(json.id),
    title: optionalText(json.title) ?? "",
    createdAt: instant(json.inserted_at),
    updatedAt: instant(json.updated_at),
    messages: tree.messages,
    rootMessageId: tree.rootMessageId,
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
/**
 * 比较消息 id 的大小。
 *
 * 官方 id 是自增整数，但可能超出 Number 的安全范围，所以纯数字 id 先比长度再比字典序，
 * 避免精度丢失导致「默认选中的分支」选错。
 */
const compareIds = (left: string, right: string): number => {
  const numeric = /^\d+$/.test(left) && /^\d+$/.test(right)
  if (numeric) {
    if (left.length !== right.length) {
      return left.length - right.length
    }
    return left < right ? -1 : left > right ? 1 : 0
  }
  if (/^\d+$/.test(left) !== /^\d+$/.test(right)) {
    // 数字 id 排在非数字之后（正反必须对称，否则比较结果随机）
    return /^\d+$/.test(left) ? 1 : -1
  }
  return left < right ? -1 : left > right ? 1 : 0
}
