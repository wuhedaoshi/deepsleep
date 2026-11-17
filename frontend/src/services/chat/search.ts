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
}

type IndexEntry = {
  id: string
  title: string
  titleLower: string
  updatedAt: number
  /** 全文小写拼接，用于 includes 检索 */
  body: string
}

let cache: IndexEntry[] | null = null
let building: Promise<IndexEntry[]> | null = null
/** 会话集合指纹：标题/数量变化时重建索引 */
let fingerprint = ''

const bodyOf = (session: Session): string => {
  const parts: string[] = []
  for (const message of session.messages) {
    if (message.role === 'user') {
      parts.push(message.content)
      continue
    }
    for (const block of message.blocks) {
      if (block.type === 'text') {
        parts.push(block.text)
      }
    }
  }
  return parts.join('\n')
}

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
      body: bodyOf(session).toLowerCase(),
    })
  }
  return entries
}

/** 让索引与会话列表对齐；只有数量或标题变了才重建，避免每次输入都扫库。 */
const ensureIndex = async (): Promise<IndexEntry[]> => {
  const sessions = await db.loadSessionSummaries()
  const next = sessions.map((session) => `${session.id}:${session.title ?? ''}`).join('|')
  if (cache && next === fingerprint) {
    return cache
  }
  if (building) {
    return building
  }
  fingerprint = next
  building = buildIndex(sessions).then((entries) => {
    cache = entries
    building = null
    return entries
  })
  return building
}

export const invalidateSearchIndex = () => {
  cache = null
  fingerprint = ''
}

const snippetOf = (body: string, keyword: string): string => {
  const at = body.indexOf(keyword)
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
    const inTitle = entry.titleLower.includes(keyword)
    const snippet = inTitle ? '' : snippetOf(entry.body, keyword)
    if (!inTitle && !snippet) {
      continue
    }
    hits.push({
      id: entry.id,
      title: entry.title || '新对话',
      updatedAt: entry.updatedAt,
      snippet,
      inTitle,
    })
  }
  hits.sort((a, b) => {
    if (a.inTitle !== b.inTitle) {
      return a.inTitle ? -1 : 1
    }
    return b.updatedAt - a.updatedAt
  })
  return hits.slice(0, limit)
}
