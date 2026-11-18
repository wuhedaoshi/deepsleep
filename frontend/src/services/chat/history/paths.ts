/**
 * 归档条目名与 id 规则。
 *
 * **唯一来源**：导入（archive.ts）、导出（exportArchive.ts）都走这里，避免出现
 * 「能导出却导不回来」这种单向规则（历史问题：`s.1` 这类含点 id）。
 *
 * 规则照抄官方 `chat-demo/src/services/chat/history/paths.ts`：
 * - 会话 id：字符串、非空、不等于 `.` / `..`、不含 `/` 与 `\`；**允许点、非 ASCII，不设长度上限**
 * - 目录段：`/` `\` 换成 `_`；空值 / `.` / `..` 换成 `unnamed`
 * - 条目路径两端统一 NFC（官方导入器按 NFC 比对）
 */

/** 会话 id 是否合法；合法则返回原值，否则 null */
export const readSessionId = (value: unknown): string | null => {
  if (typeof value !== 'string' || value === '') {
    return null
  }
  if (value === '.' || value === '..') {
    return null
  }
  if (value.includes('/') || value.includes('\\')) {
    return null
  }
  return value
}

/** 把任意字符串变成安全的一段路径；与官方 `safeName` 一致 */
export const safePathSegment = (value: string): string => {
  const replaced = value.replace(/[/\\]/g, '_')
  return replaced === '' || replaced === '.' || replaced === '..' ? 'unnamed' : replaced
}

/** 会话 JSON 的条目名 */
export const sessionEntryPath = (sessionId: string): string =>
  `chat_sessions/${safePathSegment(sessionId)}.json`

/** 会话自己的附件目录，带结尾斜杠 */
export const sessionFilesDir = (sessionId: string): string =>
  `chat_sessions/${safePathSegment(sessionId)}_files/`

/** 附件条目名 */
export const attachmentEntryPath = (sessionId: string, fileId: string, name: string): string =>
  `${sessionFilesDir(sessionId)}${safePathSegment(fileId)}_${safePathSegment(name)}`.normalize('NFC')

/** 从条目名解析会话 id；不是会话 JSON 时返回 null */
export const parseSessionPath = (path: string): string | null => {
  const matched = /^chat_sessions\/([^/]+)\.json$/.exec(path)
  return matched === null ? null : readSessionId(matched[1])
}

/**
 * 从条目名解析附件归属。
 *
 * **只取会话 id 与「id_文件名」尾巴，不拆 id**：附件 id 本身可能含下划线
 * （`f_a`），按文件名反解会把它截成 `f`，导致原件对不上会话 JSON 里的引用。
 * 真正的 fileId 要以会话 JSON 的 `FILE.export_path` 为准（见 archive 的绑定逻辑）。
 */
export const parseAttachmentPath = (
  path: string
): { sessionId: string; tail: string } | null => {
  const matched = /^chat_sessions\/([^/]+)_files\/(.+)$/.exec(path)
  if (matched === null) {
    return null
  }
  const sessionId = readSessionId(matched[1])
  if (sessionId === null) {
    return null
  }
  return { sessionId, tail: matched[2] }
}
/**
 * 本地 v4 导出用的附件条目名：`chat_sessions/{sessionId}_files/{fileId}_{name}`。
 * 与 v3 的 `attachmentEntryPath` 规则相同，单独命名是为了让导入端意图更清楚。
 */
export const attachmentPathOf = (sessionId: string, fileId: string, name: string): string =>
  attachmentEntryPath(sessionId, fileId, name)