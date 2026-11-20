import * as db from './db.js'
import type { Session, SessionSummary } from './types.js'

/** 一条搜索结果：会话标题 + 命中位置附近的上下文片段。 */
export type SearchHit = {
  id: string
  title: string
  updatedAt: number
  snippet: string
  /** 命中来自标题还是正文 */
  inTitle: boolean
  messageId?: string
}

type IndexEntry = {
  id: string
  title: string
  titleLower: string
  updatedAt: number
  messages: { id: string; body: string }[]
}

let cache: IndexEntry[] | null = null
let building: Promise<IndexEntry[]> | null = null
let fingerprint = ''

const messageIndex = (session: Session): IndexEntry['messages'] =>
  session.messages.map((message) => ({
    id: message.id,
    body:
      message.role === 'user'
        ? message.content
        : message.blocks.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n'),
  }))

const buildIndex = async (sessions: SessionSummary[]): Promise<IndexEntry[]> => {
  const entries: IndexEntry[] = []
  for (const summary of sessions) {
    const session = await db.loadSession(summary.id)
    if (!session) {
      continue
    }
    const title = summary.title || ''
    entries.push({
      id: summary.id,
      title,
      titleLower: title.toLowerCase(),
      updatedAt: summary.updatedAt,
      messages: messageIndex(session),
    })
  }
  return entries
}

/** 让索引与会话列表对齐；会话元数据变化时才重建，避免每次输入都扫库。 */
const ensureIndex = async (): Promise<IndexEntry[]> => {
  const sessions = await db.loadSessionSummaries()
  const next = JSON.stringify(sessions.map(({ id, title, updatedAt }) => [id, title, updatedAt]))
  if (cache && next === fingerprint) {
    return cache
  }
  if (building) {
    return building
  }
  building = buildIndex(sessions)
    .then((entries) => {
      fingerprint = next
      cache = entries
      return entries
    })
    .finally(() => {
      building = null
    })
  return building
}

export const invalidateSearchIndex = () => {
  cache = null
  fingerprint = ''
}

const snippetOf = (body: string, keyword: string): string => {
  const at = body.toLowerCase().indexOf(keyword)
  if (at < 0) {
    return ''
  }
  const start = Math.max(0, at - 16)
  const end = Math.min(body.length, at + keyword.length + 24)
  const raw = body.slice(start, end).replace(/\s+/g, ' ')
  return `${start > 0 ? '…' : ''}${raw}${end < body.length ? '…' : ''}`
}

/**
 * 全库检索：标题命中优先，其次正文命中，各自按更新时间倒序。
 *
 * 索引是懒建的：第一次搜索把全部会话从 IndexedDB 读一遍并拼成小写正文，
 * 之后的输入只做字符串匹配。会话增删改会让指纹变化并触发重建。
 */
export const searchConversations = async (rawKeyword: string, limit = 60): Promise<SearchHit[]> => {
  const keyword = rawKeyword.trim().toLowerCase()
  if (!keyword) {
    return []
  }
  const entries = await ensureIndex()
  const hits: SearchHit[] = []
  for (const entry of entries) {
    const base = { id: entry.id, title: entry.title || '新对话', updatedAt: entry.updatedAt }
    if (entry.titleLower.includes(keyword)) {
      hits.push({ ...base, inTitle: true, snippet: '' })
    }
    let matches = 0
    for (const message of entry.messages) {
      const snippet = snippetOf(message.body, keyword)
      if (!snippet) {
        continue
      }
      hits.push({ ...base, inTitle: false, snippet, messageId: message.id })
      if (++matches >= limit) {
        break
      }
    }
  }
  hits.sort((a, b) => {
    if (a.inTitle !== b.inTitle) {
      return a.inTitle ? -1 : 1
    }
    return b.updatedAt - a.updatedAt
  })
  return hits.slice(0, limit)
}
