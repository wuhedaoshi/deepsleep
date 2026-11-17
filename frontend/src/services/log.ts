/**
 * 运行日志：只记「发生了什么」，不记「说了什么」。
 *
 * 排查一个白屏/导入失败，需要的是时间线：什么时候启动、导入到第几个会话、
 * 哪个 API 调用报了什么错。这些都不需要对话正文、也不需要 API Key。
 * 所以这里做两件事：
 *   1. 进缓冲区的字段先过一遍脱敏（Key、Bearer、长 base64、user 目录路径都替换掉）；
 *   2. 只保留结构化摘要——条数、字节数、状态码、错误文本，不保留消息内容。
 *
 * 输出三条路：内存环形缓冲（应用内查看）、原生文件（Android/data/.../files/logs，
 * 用户可以自己翻）、以及导出成文本走系统保存对话框。
 */

export type LogLevel = 'info' | 'warn' | 'error'

export type LogEntry = {
  /** 毫秒时间戳 */
  at: number
  level: LogLevel
  /** 分类，便于过滤：boot / import / export / chat / compaction / media / ui */
  scope: string
  message: string
}

/** 环形缓冲上限：够回放一次操作，又不至于吃内存 */
const MAX_ENTRIES = 800

const entries: LogEntry[] = []

/** 单条消息上限：异常对象偶尔会把整个响应体塞进 message */
const MAX_MESSAGE = 1200

/**
 * 脱敏：把可能出现的凭据、路径、长串抹掉。
 * 宁可多抹一点——日志是给外人看的（发到群里/贴到 issue）。
 */
export const redact = (text: string): string =>
  text
    // API Key（sk- 开头）与任何 Authorization 值
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-***')
    .replace(/(Bearer\s+)[A-Za-z0-9._-]{8,}/gi, '$1***')
    // 长 base64 / data URI（图片、归档片段）
    .replace(/data:([\w/+.-]+);base64,[A-Za-z0-9+/=]{40,}/g, 'data:$1;base64,***')
    // 16 位以上的连续 base64 串（多半是二进制片段）
    .replace(/[A-Za-z0-9+/]{80,}={0,2}/g, '***')
    // 本机绝对路径里的用户名与中文目录
    .replace(/\/data\/user\/\d+\/[\w./-]+/g, '/data/user/<uid>/…')
    .replace(/[A-Za-z]:\\Users\\[^\\\s]+/g, 'C:\\Users\\<user>')
    .replace(/\/(?:home|Users)\/[^/\s]+/g, '/<user>')
    .slice(0, MAX_MESSAGE)

const formatValue = (value: unknown): string => {
  if (value === undefined) {
    return ''
  }
  if (typeof value === 'string') {
    return value
  }
  if (value instanceof Error) {
    return `${value.name}: ${value.message}`
  }
  try {
    // 只展开一层，避免循环引用与超大对象
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

const push = (level: LogLevel, scope: string, message: string, detail?: unknown) => {
  const extra = formatValue(detail)
  const line = redact(extra === '' ? message : `${message} | ${extra}`)
  const entry: LogEntry = { at: Date.now(), level, scope, message: line }
  entries.push(entry)
  if (entries.length > MAX_ENTRIES) {
    entries.splice(0, entries.length - MAX_ENTRIES)
  }
  // 原生侧同时落盘：Android 上写到 Android/data/<pkg>/files/logs，用户能自己翻
  const bridge = (window as { __deepsleepNative?: { appendLog?: (line: string) => void } })
    .__deepsleepNative
  if (bridge?.appendLog) {
    bridge.appendLog(`${new Date(entry.at).toISOString()} ${level.toUpperCase()} [${scope}] ${line}`)
  }
}

export const logInfo = (scope: string, message: string, detail?: unknown) => push('info', scope, message, detail)
export const logWarn = (scope: string, message: string, detail?: unknown) => push('warn', scope, message, detail)
export const logError = (scope: string, message: string, detail?: unknown) => push('error', scope, message, detail)

export const getLogEntries = (): readonly LogEntry[] => entries

/** 导出用的纯文本：一行一条，带 ISO 时间，方便贴到群里或 issue 里 */
export const formatLog = (list: readonly LogEntry[] = entries): string =>
  list
    .map((entry) => `${new Date(entry.at).toISOString()} ${entry.level.toUpperCase()} [${entry.scope}] ${entry.message}`)
    .join('\n')

export const clearLog = () => {
  entries.length = 0
}

/** 环境摘要：排查第一眼看的就是这些 */
export const describeEnvironment = () => {
  const bridge = (window as { __deepsleepNative?: Record<string, unknown> }).__deepsleepNative
  const nav = navigator as Navigator & { deviceMemory?: number }
  return {
    userAgent: navigator.userAgent,
    platform: navigator.platform,
    language: navigator.language,
    deviceMemoryGB: nav.deviceMemory ?? null,
    hardwareConcurrency: navigator.hardwareConcurrency ?? null,
    viewport: `${window.innerWidth}x${window.innerHeight}@${window.devicePixelRatio}x`,
    storage: navigator.storage ? 'yes' : 'no',
    native: bridge ? 'yes' : 'no',
  }
}

let installed = false

/**
 * 装全局兜底：未捕获异常、未处理的 Promise 拒绝、以及 console.error。
 * 这三类正是「白屏」最常见的来源，而它们平时不会留下任何痕迹。
 */
export const installLogHandlers = () => {
  if (installed) {
    return
  }
  installed = true
  window.addEventListener('error', (event) => {
    const target = event.target as HTMLElement | null
    if (target && target !== (window as unknown as HTMLElement)) {
      push('error', 'window', `资源加载失败：${target.tagName ?? 'unknown'}`)
      return
    }
    push('error', 'window', event.message || 'uncaught error', {
      source: event.filename,
      line: event.lineno,
      column: event.colno,
      stack: event.error instanceof Error ? (event.error.stack ?? '').slice(0, 600) : '',
    })
  })
  window.addEventListener('unhandledrejection', (event) => {
    // 同时打 console：WebChromeClient 会把 console 转进 logcat，adb 在场时能直接看
    const reason = event.reason
    push('error', 'promise', 'unhandled rejection', reason instanceof Error ? reason.message : reason)
  })
  // 这里就是接管 console.error 本身，规则要放行
  // eslint-disable-next-line no-console
  const originalError = console.error
  // eslint-disable-next-line no-console
  console.error = (...args: unknown[]) => {
    push('error', 'console', args.map((item) => formatValue(item)).join(' '))
    originalError.apply(console, args)
  }
}

/**
 * 启动哨兵：上一次启动没走到「就绪」就没了（白屏/被系统杀掉），下次打开能看出来。
 *
 * 注意顺序：**先读旧标记再写新标记**，否则读到的是本次刚写的那条，每次启动都误报。
 * 另外要求旧标记至少 10 秒，避免把「同一秒内刷新页面」当成崩溃。
 */
const BOOT_KEY = 'deepsleep:boot-state'
const BOOT_STALE_MS = 10_000
/** 连续多少次启动异常就进恢复界面 */
export const CRASH_LOOP_THRESHOLD = 2
const FAIL_KEY = 'deepsleep:boot-failures'
/** 上一次启动遗留的标记，由 `markBootStart` 在覆盖前捕获 */
let previousBootAt: number | null = null
/** 本次启动前已经连续异常过几次 */
let bootFailures = 0

export const markBootStart = () => {
  try {
    const raw = localStorage.getItem(BOOT_KEY)
    if (raw !== null && raw.startsWith('starting:')) {
      const at = Number(raw.split(':')[1] ?? 0)
      // 只认「够旧的」未完成标记：本次刷新造成的假崩溃不记
      previousBootAt = Number.isFinite(at) && Date.now() - at > BOOT_STALE_MS ? at : null
      bootFailures = previousBootAt === null ? 0 : Number(localStorage.getItem(FAIL_KEY) ?? '0') + 1
    } else {
      previousBootAt = null
      bootFailures = 0
    }
    localStorage.setItem(FAIL_KEY, String(bootFailures))
    localStorage.setItem(BOOT_KEY, `starting:${Date.now()}`)
  } catch {
    // 隐私模式下写入失败，不影响使用
  }
}

export const markBootReady = () => {
  try {
    localStorage.setItem(BOOT_KEY, `ready:${Date.now()}`)
    localStorage.setItem(FAIL_KEY, '0')
  } catch {
    // 同上
  }
}

/** 上次启动是否异常结束（由 `markBootStart` 在覆盖前捕获）；没有则返回 null */
export const previousBootCrashed = (): number | null => previousBootAt
/** 本次启动前已连续异常的次数（在 `markBootStart` 里累加） */
export const bootFailureCount = (): number => bootFailures

/** 恢复正常启动：把计数清零，下次不再进恢复界面 */
export const resetBootFailures = () => {
  bootFailures = 0
  try {
    localStorage.setItem(FAIL_KEY, '0')
  } catch {
    // 隐私模式下写不进去，不影响
  }
}
/**
 * 命中测试：白屏时「屏幕上到底画了什么」。
 *
 * 取屏幕中轴三个点（上/中/下）做 elementFromPoint，把标签、class 与文本前若干字记下来。
 * 如果三个点都落在同一层白色容器上，说明是覆盖层；如果落在 body 上，
 * 说明该区域根本没渲染内容——两种原因完全不同。
 */
export const logHitTest = (tag: string) => {
  try {
    const samples = [0.15, 0.5, 0.85].map((ratio) => {
      const element = document.elementFromPoint(
        Math.round(window.innerWidth / 2),
        Math.round(window.innerHeight * ratio)
      )
      if (element === null) {
        return 'null'
      }
      const className = typeof element.className === 'string' ? element.className : ''
      const text = (element.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 24)
      return `${element.tagName.toLowerCase()}.${className.split(' ')[0] || '-'}${text === '' ? '' : `「${text}」`}`
    })
    push('info', 'layout', `hittest ${tag}`, { points: samples })
  } catch {
    // 量不出来不影响主流程
  }
}

/** 记录关键设置是否还在（只记有没有、长度，不记内容） */
export const logSettingsPresence = (tag: string) => {
  try {
    // 设置是一项一个键（settings.ts 的 KEYS），不是单个 JSON
    const raw = localStorage.getItem('deepsleep:api-key')
    const key = raw ?? ''
    push('info', 'settings', `${tag}: apiKey=${key.trim() === '' ? 'missing' : 'present'}`, {
      len: key.length,
      storageKeys: Object.keys(localStorage).length,
    })
  } catch (error) {
    push('warn', 'settings', `${tag}: 读本地设置失败`, error)
  }
}
/** 记录一次布局几何：区分「没渲染」与「有内容但看不见」 */
export const logLayout = (tag: string) => {
  try {
    const rootElement = document.getElementById('root')
    const rect = rootElement?.getBoundingClientRect()
    const body = getComputedStyle(document.body)
    push('info', 'layout', tag, {
      viewport: `${window.innerWidth}x${window.innerHeight}`,
      visual: `${window.visualViewport?.width ?? 0}x${window.visualViewport?.height ?? 0}`,
      doc: `${document.documentElement.clientWidth}x${document.documentElement.clientHeight}`,
      root: rect ? `${Math.round(rect.width)}x${Math.round(rect.height)}` : 'none',
      rootChildren: rootElement?.childElementCount ?? -1,
      bodyText: (document.body.innerText ?? '').trim().length,
      bg: body.backgroundColor,
      color: body.color,
      dpr: window.devicePixelRatio,
    })
  } catch {
    // 量不出来不影响主流程
  }
}