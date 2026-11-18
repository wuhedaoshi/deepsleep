/**
 * 导出为**官方格式**（`export_format_version: 3`）的 ZIP。
 *
 * 为什么不用自己的格式：导出包要能被三处吃下——官方网页版的「导入历史对话」、实验线（只认 v3）、
 * 以及我们自己的导入器。1.2.6 曾经导出过 v4（本地结构、往返无损），代价是那两方都读不了，
 * 属于把自己锁死；1.2.8 起改回 v3，导入侧继续同时支持 v3 和 v4（老的 v4 包仍能导入）。
 *
 * v3 的消息是 `fragments` 数组、分支靠 `parent_id` + `current_message_id`，
 * 而且消息 id 必须是整数——官方解析器用 `Number.isSafeInteger` 校验。
 * 本地 id 是字符串（新会话是 uuid），所以导出时**按顺序重编号**成本会话内的 1..N。
 *
 * 写包是流式的：fflate 每产出一块就交给 sink，峰值只跟单个 entry 有关，不做整包物化。
 */
import type { AssistantMessage, Message, ReplyBlock, Session, UserMessage } from '../types.js'
import { normalizeSession } from '../branches.js'
import { BackupError } from './errors.js'
import { ownedBytes } from './zip.js'

const FORMAT_VERSION = 3
/** 单次 push 给压缩器的切片大小；1 MiB 足够摊薄调用开销，又不至于让 sink 背压时堆太多。 */
const SLICE = 1 << 20

export type ExportSource = {
  sessions: AsyncIterable<Session>
  /** 读附件原件；返回 undefined 表示本地没有原件，导出里就不带这个文件 */
  file: (id: string) => Promise<Blob | undefined>
}

/** 逐块接收压缩后的 ZIP 字节（原生桥 / Blob 拼接都接这个）。 */
export type ChunkSink = (chunk: Uint8Array<ArrayBuffer>) => void | Promise<void>

type Json = Record<string, unknown>

const iso = (value: number): string => {
  // 官方 schema 要求 `YYYY-MM-DDTHH:mm:ssZ`；NaN / 越界时间会写成 "Invalid Date"，整包被拒
  if (!Number.isFinite(value) || value < 0 || value > 253_402_300_799_000) {
    throw new BackupError('backupIncomplete')
  }
  return new Date(value).toISOString()
}

const totalTokens = (message: AssistantMessage): number => {
  const usage = message.usage
  if (!usage) {
    return 0
  }
  return (
    usage.input_tokens +
    usage.cache_creation_input_tokens +
    usage.cache_read_input_tokens +
    usage.output_tokens
  )
}

const messageStatus = (message: Message): string => {
  if (message.role === 'user') {
    return 'FINISHED'
  }
  if (message.status === 'done') {
    return message.stopReason === 'refusal' ? 'CONTENT_FILTER' : 'FINISHED'
  }
  if (message.status === 'error') {
    return 'FAILED'
  }
  // pending / streaming / stopped 都按「没走完」写；官方侧对应的枚举是 INCOMPLETE。
  return 'INCOMPLETE'
}

/** 归档里附件路径由会话 id 与附件 id 拼成；名字里的斜杠必须先抹平。 */
// 只保留安全字符：控制字符（含 NUL）、路径分隔符、Windows 保留符号、点段一律替换。
// 控制字符用码点过滤而不是正则里的 \u0000-\u001f 范围（会被 lint 判为 no-control-regex）。
const safeName = (name: string): string =>
  Array.from(name)
    .map((char) => ((char.codePointAt(0) ?? 0) < 0x20 ? '_' : char))
    .join('')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\.{2,}/g, '_')
    .replace(/^\.+/, '_')
    .slice(0, 80) || 'file'

/**
 * 会话 id / 附件 id 会直接进 ZIP 路径，必须先是「安全的一段路径」。
 *
 * 本地 v4 归档转出来的 id 不受我们控制（可能是 `../x`），拼进路径后官方导入器
 * 会认为归档损坏、整包拒绝。这里提前拦下。
 */
const assertSafeId = (value: string): string => {
  const safe = /^[A-Za-z0-9._-]+$/.test(value) && !value.includes('..') && value !== '.' && value !== ''
  if (!safe) {
    throw new BackupError('backupIncomplete')
  }
  return value
}

const attachmentPath = (sessionId: string, fileId: string, name: string): string =>
  `chat_sessions/${assertSafeId(sessionId)}_files/${assertSafeId(fileId)}_${safeName(name)}`

const userFragments = (message: UserMessage, sessionId: string): Json[] => {
  const fragments: Json[] = [{ type: 'REQUEST', content: message.content }]
  if (message.files.length > 0) {
    fragments.push({
      type: 'FILE',
      files: message.files.map((file) => ({
        id: file.id,
        file_name: file.name,
        file_size: file.size,
        token_usage: 0,
        inserted_at: iso(message.createdAt),
        export_path: attachmentPath(sessionId, file.id, file.name),
        is_image: file.isImage,
      })),
    })
  }
  return fragments
}

const searchResults = (block: Extract<ReplyBlock, { type: 'web_search_tool_result' }>): Json[] =>
  block.content.flatMap((item) =>
    item.type === 'web_search_result'
      ? [
          {
            url: item.url,
            title: item.title,
            snippet: item.snippet,
            ...(item.page_age === null ? {} : { published_at: item.page_age }),
            ...(item.site_icon === null ? {} : { site_icon: item.site_icon }),
            ...(item.site_name === null ? {} : { site_name: item.site_name }),
          },
        ]
      : []
  )

const hasError = (block: ReplyBlock): boolean =>
  (block.type === 'web_search_tool_result' &&
    block.content.some((item) => item.type === 'web_search_tool_result_error')) ||
  (block.type === 'web_fetch_tool_result' &&
    block.content.type === 'web_fetch_tool_result_error')

/**
 * 工具块是「调用 + 结果」成对出现的，官方格式里它们合成**一个** fragment：
 * `TOOL_SEARCH` / `TOOL_OPEN` / `TOOL_FIND` / `READ_LINK`，状态写在 fragment.status 上。
 * 这里顺带吃掉紧随其后的结果块，避免它变成一个空的废弃 fragment。
 */
const replyFragments = (blocks: readonly ReplyBlock[]): Json[] => {
  const fragments: Json[] = []
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index]
    if (block.type === 'text') {
      fragments.push(
        block.isTemplate === true
          ? { type: 'TEMPLATE_RESPONSE', content: block.text }
          : { type: 'RESPONSE', content: block.text }
      )
      continue
    }
    if (block.type === 'thinking') {
      fragments.push({
        type: 'THINK',
        content: block.thinking,
        ...(block.elapsedSeconds === undefined ? {} : { elapsed_secs: block.elapsedSeconds }),
      })
      continue
    }
    if (block.type !== 'server_tool_use') {
      // 没有配对调用块的结果块（历史数据里可能有）没有地方安放，丢弃。
      continue
    }
    const next = blocks[index + 1]
    const paired = next !== undefined && next.type !== 'text' && next.type !== 'thinking' && next.type !== 'server_tool_use' && next.tool_use_id === block.id
    const result = paired ? next : undefined
    if (result !== undefined) {
      index += 1
    }
    const status = result === undefined ? 'WIP' : hasError(result) ? 'FAILED' : 'FINISHED'
    switch (block.input.action) {
      case 'search':
        fragments.push({
          type: 'TOOL_SEARCH',
          queries: block.input.queries,
          results: result !== undefined && result.type === 'web_search_tool_result' ? searchResults(result) : [],
          status,
        })
        break
      case 'open_page': {
        const document = result !== undefined && result.type === 'web_fetch_tool_result' && result.content.type === 'web_fetch_result' ? result.content : undefined
        fragments.push({
          type: 'TOOL_OPEN',
          status,
          url: block.input.url,
          ...(document === undefined ? {} : { title: document.content.title }),
          ...(document === undefined || document.published_at === null ? {} : { published_at: document.published_at }),
        })
        break
      }
      case 'find_in_page':
        fragments.push({
          type: 'TOOL_FIND',
          status,
          url: block.input.url,
          pattern: block.input.pattern,
        })
        break
      case 'read_link': {
        const signature = result !== undefined && result.type === 'web_fetch_tool_result' ? result.signature : undefined
        fragments.push({
          type: 'READ_LINK',
          results: [
            {
              signature: signature ?? '',
              url: block.input.url,
              ...(result !== undefined && result.type === 'web_fetch_tool_result' && result.content.type === 'web_fetch_result' && result.content.content.title !== null
                ? { title: result.content.content.title }
                : {}),
            },
          ],
        })
        break
      }
    }
  }
  return fragments
}

/**
 * 拓扑排序：父节点一定排在子节点之前。
 *
 * 官方导入器按 id 升序逐条处理，父 id 比子 id 大时会找不到父节点、整包判为损坏。
 * 本地消息数组的顺序没有这个保证（重新生成、切分支都会打乱），所以导出前统一重排。
 */
const topologicalOrder = (session: Session): Message[] => {
  const children = new Map<string, Message[]>()
  const roots: Message[] = []
  for (const message of session.messages) {
    const parentId = message.parentId
    if (parentId === null || parentId === undefined) {
      roots.push(message)
      continue
    }
    const list = children.get(parentId)
    if (list) {
      list.push(message)
    } else {
      children.set(parentId, [message])
    }
  }
  const ordered: Message[] = []
  const queue: Message[] = [...roots]
  let head = 0
  while (head < queue.length) {
    const message = queue[head]
    head += 1
    ordered.push(message)
    const kids = children.get(message.id)
    if (kids) {
      for (const kid of kids) {
        queue.push(kid)
      }
    }
  }
  // 走不完说明有环或父缺失——前面已经校验过，这里只是兜底
  if (ordered.length !== session.messages.length) {
    throw new BackupError('backupIncomplete')
  }
  // 排序只用于编号；回填一份按 id 顺序排列的数组便于对照（调用方按返回顺序写 JSON）
  return ordered
}

/**
 * 导出前的结构校验：脏数据不能写成「看起来合法」的归档。
 *
 * 官方导入器对分支的要求是「每条消息的父存在、根必须唯一、无环」。
 * 本地数据可以从 v4 归档或旧版本迁进来，不保证满足这些前提；
 * 与其导出一个导入必失败的包，不如在这里明确报错。
 */
const assertTreeExportable = (session: Session): void => {
  const ids = new Set<string>()
  for (const message of session.messages) {
    if (ids.has(message.id)) {
      throw new BackupError('backupIncomplete')
    }
    ids.add(message.id)
  }
  for (const message of session.messages) {
    const parentId = message.parentId
    if (parentId !== null && parentId !== undefined && !ids.has(parentId)) {
      // 父不存在：以前会被静默当成根节点，导出后成了多个根
      throw new BackupError('backupIncomplete')
    }
  }
  // 角色约束（官方导入器同样校验）：根必须是提问，父子之间角色必须交替。
  // 本地可以从 v4 归档迁进来，不保证满足；不拦下来就会导出成「导入必失败」的包。
  const roleOf = new Map(session.messages.map((message) => [message.id, message.role]))
  for (const message of session.messages) {
    const parentId = message.parentId
    if (parentId === null || parentId === undefined) {
      if (message.role !== 'user') {
        throw new BackupError('backupIncomplete')
      }
      continue
    }
    if (roleOf.get(parentId) === message.role) {
      throw new BackupError('backupIncomplete')
    }
  }
  // 环检测：迭代标记，每个节点最多访问一次
  const state = new Map<string, number>()
  const byId = new Map(session.messages.map((message) => [message.id, message]))
  for (const message of session.messages) {
    if (state.get(message.id) === 2) {
      continue
    }
    const path: string[] = []
    let cursor: Message | undefined = message
    while (cursor !== undefined) {
      const seen = state.get(cursor.id)
      if (seen === 2) {
        break
      }
      if (seen === 1) {
        throw new BackupError('backupIncomplete')
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
}

const sessionJson = (raw: Session): { json: Json; files: { id: string; name: string }[] } => {
  // 升级前保存的线性会话没有分支字段：先补齐，否则导出会写出多个根节点，官方导入器直接拒绝。
  const session = normalizeSession(raw)
  assertTreeExportable(session)
  const files: { id: string; name: string }[] = []
  // 官方用整数 id，本地是字符串（新会话是 uuid）。编号顺序**必须保证父在子之前**：
  // 官方导入器按 id 升序处理，父 id 更大时会找不到父节点而整包失败。
  // 所以先做拓扑排序（根 → 子），再按这个顺序编号。
  const ordered = topologicalOrder(session)
  const idOf = new Map<string, number>()
  ordered.forEach((message, index) => {
    idOf.set(message.id, index + 1)
  })
  const messages = ordered.map((message, index): Json => {
    const id = index + 1
    const localParent = message.parentId
    const parentId = localParent === null || localParent === undefined ? null : (idOf.get(localParent) ?? null)
    if (message.role === 'user') {
      for (const file of message.files) {
        files.push({ id: file.id, name: file.name })
      }
      return {
        id,
        parent_id: parentId,
        role: 'USER',
        status: 'FINISHED',
        thinking_enabled: false,
        search_enabled: false,
        accumulated_token_usage: 0,
        inserted_at: iso(message.createdAt),
        fragments: userFragments(message, session.id),
      }
    }
    return {
      id,
      parent_id: parentId,
      role: 'ASSISTANT',
      status: messageStatus(message),
      thinking_enabled: message.thinking === true,
      search_enabled: message.search === true,
      accumulated_token_usage: totalTokens(message),
      inserted_at: iso(message.createdAt),
      fragments: replyFragments(message.blocks),
    }
  })
  // current_message_id 指向「当前分支的叶子」，官方导入器据此还原用户停留的位置；
  // 指向数组末尾在分叉会话里是错的。
  const leaf = findCurrentLeaf(session, idOf)
  return {
    json: {
      id: session.id,
      title: session.title,
      pinned: session.pinned === true,
      current_message_id: messages.length === 0 ? 0 : leaf,
      inserted_at: iso(session.createdAt),
      updated_at: iso(session.updatedAt),
      messages,
    },
    files,
  }
}

/**
 * 找出当前分支的最末一条消息（导出时作为 `current_message_id`）。
 *
 * 从根沿 selectedChildId 走到底；分支信息缺失时退化为「数组最后一条」。
 */
const findCurrentLeaf = (session: Session, idOf: Map<string, number>): number => {
  const byId = new Map(session.messages.map((message) => [message.id, message]))
  const rootId = session.rootMessageId
  const start = rootId === null || rootId === undefined ? session.messages[0] : byId.get(rootId)
  if (start === undefined) {
    return session.messages.length
  }
  let cursor: Message = start
  const seen = new Set<string>()
  for (;;) {
    if (seen.has(cursor.id)) {
      return idOf.get(cursor.id) ?? session.messages.length
    }
    seen.add(cursor.id)
    const nextId = cursor.selectedChildId
    const next = nextId === undefined ? undefined : byId.get(nextId)
    if (next === undefined) {
      return idOf.get(cursor.id) ?? session.messages.length
    }
    // 选中的子节点必须真的以当前节点为父；否则 current_message_id 会指到另一条分支上，
    // 官方导入器按这条路径还原就会落到错误的根。
    if (next.parentId !== cursor.id) {
      throw new BackupError('backupIncomplete')
    }
    cursor = next
  }
}

/**
 * 以官方 v3 格式流式写出归档。顺序沿用官方的物理布局：
 * `manifest` → 各会话 JSON（紧跟自己的附件）→ `chat_session_index.json`。
 * 旧版导入器依赖这个顺序（manifest 必须第一个、会话早于 index、图片晚于会话）。
 */
export const exportArchiveTo = async (source: ExportSource, sink: ChunkSink): Promise<void> => {
  const { Zip, ZipDeflate, ZipPassThrough, strToU8 } = await import('fflate')
  const pending: Uint8Array<ArrayBuffer>[] = []
  let failure: unknown = null
  const zip = new Zip((error, chunk) => {
    if (error) {
      failure = error
      return
    }
    if (chunk.length > 0) {
      pending.push(ownedBytes(chunk))
    }
  })
  const flush = async () => {
    for (;;) {
      const next = pending.shift()
      if (next === undefined) {
        return
      }
      await sink(next)
    }
  }
  const check = async () => {
    await flush()
    if (failure !== null) {
      throw failure instanceof Error ? failure : new Error('zip write failed')
    }
  }

  const addJson = async (name: string, value: unknown) => {
    const stream = new ZipDeflate(name, { level: 6 })
    zip.add(stream)
    const bytes = strToU8(JSON.stringify(value))
    for (let at = 0; at < bytes.length; at += SLICE) {
      const end = Math.min(at + SLICE, bytes.length)
      stream.push(bytes.subarray(at, end), end === bytes.length)
      await check()
    }
  }

  const addBlob = async (name: string, blob: Blob) => {
    // 图片本来就是压缩格式，过一遍 deflate 只是白烧 CPU。
    const stream = new ZipPassThrough(name)
    zip.add(stream)
    // 空文件也必须走一次 push(…, true)：否则这个条目永远不结束，整个 ZIP 3 会在收尾时残缺
    if (blob.size === 0) {
      stream.push(new Uint8Array(0), true)
      await check()
      return
    }
    for (let at = 0; at < blob.size; at += SLICE) {
      const end = Math.min(at + SLICE, blob.size)
      const bytes = new Uint8Array(await blob.slice(at, end).arrayBuffer())
      stream.push(bytes, end === blob.size)
      await check()
    }
  }

  await addJson('manifest.json', { export_format_version: FORMAT_VERSION })

  // ZIP32 的硬上限：条目数不能到 65535（留出余量给 manifest 与索引），
  // 单条目与总大小也不能超过 4 GiB。超了 aborted 出来的包是坏的，所以提前拒绝。
  const MAX_ENTRIES = 65_000
  const MAX_TOTAL_BYTES = 4_000_000_000
  let entryCount = 1
  let totalBytes = 0

  const index: Json[] = []
  for await (const session of source.sessions) {
    const { json, files } = sessionJson(session)
    const sessionBytes = JSON.stringify(json).length
    totalBytes += sessionBytes
    if (entryCount + files.length + 2 > MAX_ENTRIES || totalBytes > MAX_TOTAL_BYTES) {
      throw new BackupError('backupTooLarge')
    }
    // 会话 id 也进 ZIP 路径：先校验再用
    assertSafeId(session.id)
    await addJson(`chat_sessions/${session.id}.json`, json)
    entryCount += 1
    index.push({
      id: session.id,
      title: session.title,
      pinned: session.pinned === true,
      message_count: session.messages.length,
      inserted_at: iso(session.createdAt),
      updated_at: iso(session.updatedAt),
    })
    const written = new Set<string>()
    for (const file of files) {
      if (written.has(file.id)) {
        continue
      }
      written.add(file.id)
      const blob = await source.file(file.id)
      if (blob === undefined) {
        continue
      }
      if (entryCount + 1 > MAX_ENTRIES || totalBytes + blob.size > MAX_TOTAL_BYTES) {
        throw new BackupError('backupTooLarge')
      }
      await addBlob(attachmentPath(session.id, file.id, file.name), blob)
      entryCount += 1
      totalBytes += blob.size
    }
  }
  // 索引最后写：官方与旧版导入器都要求会话 JSON 早于它。
  await addJson('chat_session_index.json', index)
  zip.end()
  await check()
}

/** 浏览器/桌面路径：把流拼成 Blob。手机上走原生桥，用 `exportArchiveTo` 直接落盘。 */
export const exportArchive = async (source: ExportSource): Promise<Blob> => {
  const parts: Uint8Array<ArrayBuffer>[] = []
  await exportArchiveTo(source, (chunk) => {
    parts.push(chunk)
  })
  return new Blob(parts, { type: 'application/zip' })
}
