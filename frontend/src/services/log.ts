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
  /** 单调序号（本次启动内递增），用于把前后端事件对齐 */
  seq: number
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

/** 单调序号：前后端事件靠它对齐时间线（GPT 方案里的 seq） */
let nextSeq = 1
/** 环形缓冲挤出多少条：导出时要如实声明缺口，而不是装作完整 */
let dropped = 0

const push = (level: LogLevel, scope: string, message: string, detail?: unknown) => {
  const extra = formatValue(detail)
  const line = redact(extra === '' ? message : `${message} | ${extra}`)
  const entry: LogEntry = { at: Date.now(), seq: nextSeq, level, scope, message: line }
  nextSeq += 1
  entries.push(entry)
  if (entries.length > MAX_ENTRIES) {
    const removed = entries.length - MAX_ENTRIES
    entries.splice(0, removed)
    dropped += removed
  }
  // 原生侧同时落盘：Android 上写到 Android/data/<pkg>/files/logs，用户能自己翻
  const bridge = (window as { __deepsleepNative?: { appendLog?: (line: string) => void } })
    .__deepsleepNative
  if (bridge?.appendLog) {
    // 原生落盘也带序号，导出后前端段与原生段能按 #seq 对齐
    bridge.appendLog(
      `${new Date(entry.at).toISOString()} #${String(entry.seq).padStart(4, '0')} ` +
        `${level.toUpperCase()} [${scope}] ${line}`
    )
  }
}

export const logInfo = (scope: string, message: string, detail?: unknown) => push('info', scope, message, detail)
export const logWarn = (scope: string, message: string, detail?: unknown) => push('warn', scope, message, detail)
export const logError = (scope: string, message: string, detail?: unknown) => push('error', scope, message, detail)

export const getLogEntries = (): readonly LogEntry[] => entries

/** 导出用的纯文本：一行一条，带 ISO 时间，方便贴到群里或 issue 里 */
export const formatLog = (list: readonly LogEntry[] = entries): string => {
  const body = list
    .map(
      (entry) =>
        `${new Date(entry.at).toISOString()} #${String(entry.seq).padStart(4, '0')} ` +
        `${entry.level.toUpperCase()} [${entry.scope}] ${entry.message}`
    )
    .join('\n')
  // 缺口必须写出来：没有就说没有，比假装完整有用
  const gap = dropped === 0 ? '' : `\n# 缺口：环形缓冲已丢弃 ${dropped} 条更早的记录\n`
  return gap + body
}

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
    // 旧 WebView 上补了哪些 API（见 index.html 的垫片）；空数组表示引擎本身就支持
    shims:
      (window as { __deepsleepShims?: () => string[] }).__deepsleepShims?.().join(',') ?? '',
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
    push('error', 'window', 'uncaught error', {
      kind: event.error instanceof Error ? errorSummary(event.error) : 'unknown',
      frames: (event.error instanceof Error ? (event.error.stack ?? '') : '')
        .split('\n')
        .filter((line) => line.includes('/src/'))
        .map((line) => line.trim().replace(/^at\\s+/, '').slice(0, 80))
        .slice(0, 5),
    })
  })
  window.addEventListener('unhandledrejection', (event) => {
    // 同时打 console：WebChromeClient 会把 console 转进 logcat，adb 在场时能直接看
    const reason = event.reason
    push('error', 'promise', 'unhandled rejection', errorSummary(reason))
  })
  // 这里就是接管 console.error 本身，规则要放行
  // eslint-disable-next-line no-console
  const originalError = console.error
  // eslint-disable-next-line no-console
  console.error = (...args: unknown[]) => {
    // console.error 的参数里可能有原始异常或用户数据：只记类型与白名单摘要
    push('error', 'console', args.map((item) => summarizeConsoleArg(item)).join(' '))
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
/**
 * 九宫格命中测试：把屏幕上 3×3 个点命中的元素标签与文本记下来。
 *
 * 用途：白屏时回答「屏幕上到底是不是我们的界面」。原生侧只能量像素，
 * 分不清「白色的是我们的空态页面」和「白色的是没画出来的表面」。
 */
export const logGrid = (tag: string) => {
  try {
    const points: string[] = []
    for (const y of [0.2, 0.5, 0.8]) {
      for (const x of [0.25, 0.5, 0.75]) {
        const element = document.elementFromPoint(
          Math.round(window.innerWidth * x),
          Math.round(window.innerHeight * y)
        )
        if (element === null) {
          points.push('null')
          continue
        }
        // 只记标签与首个 class：元素文本属于用户内容，不能进日志
        const className = typeof element.className === 'string' ? element.className : ''
        points.push(`${element.tagName.toLowerCase()}.${className.split(' ')[0] || '-'}`)
      }
    }
    push('info', 'layout', `grid ${tag}`, { points: points.join(' | ') })
  } catch {
    // 量不出来不影响主流程
  }
}
/**
 * 异常摘要：只留类型名与「像错误码」的片段，不记可能夹带用户数据的原文。
 * 例：TypeError:r.at is not a function → TypeError（去掉调用现场与参数）
 */
export const errorSummary = (error: unknown): string => {
  if (error instanceof Error) {
    const name = error.name || 'Error'
    const code = /^[A-Z_]{3,}$/.exec(error.message)?.[0] ?? ''
    return code === '' ? name : `${name}:${code}`
  }
  return typeof error === 'string' ? 'string' : typeof error
}
/**
 * console.error 的参数摘要。
 *
 * 接管 console.error 是为了留下痕迹，但参数里可能是原始 Error（含用户数据）。
 * 这里只保留类型名与原始值类型，不落原文。
 */
const summarizeConsoleArg = (value: unknown): string => {
  if (value instanceof Error) {
    return errorSummary(value)
  }
  if (typeof value === 'string') {
    // 字符串可能是任意内容，只记长度
    return `string(${value.length})`
  }
  if (typeof value === 'object' && value !== null) {
    return `object(${Object.keys(value as Record<string, unknown>).slice(0, 4).join(',')})`
  }
  return typeof value
}
/**
 * 启动时一次性记录**运行环境与能力**。
 *
 * 为什么值得开机就记：这类故障（同一张图、同一版本，一台设备正常、另一台失败）
 * 的判据全在环境里——WebView 版本决定有没有 `createImageBitmap` / `Blob.arrayBuffer`，
 * 渲染进程被杀时日志会断在半截。等到出问题再问用户要这些值，代价太高。
 */
export const logEnvironmentOnce = () => {
  const bridge = (window as {
    __deepsleepNative?: { getEnvironment?: () => string }
  }).__deepsleepNative
  let native: Record<string, unknown> | null = null
  if (typeof bridge?.getEnvironment === 'function') {
    try {
      native = JSON.parse(bridge.getEnvironment()) as Record<string, unknown>
    } catch {
      native = null
    }
  }
  const chromium = /Chrome\/(\d+)/.exec(navigator.userAgent)?.[1] ?? null
  let toBlob = false
  try {
    toBlob = typeof document.createElement('canvas').toBlob === 'function'
  } catch {
    toBlob = false
  }
  logInfo('env', '运行环境', {
    ...(native ?? {}),
    chromium,
    ua: navigator.userAgent.slice(0, 160),
    createImageBitmap: typeof createImageBitmap === 'function',
    blobArrayBuffer: typeof Blob.prototype.arrayBuffer === 'function',
    fileReader: typeof FileReader === 'function',
    canvasToBlob: toBlob,
    dpr: window.devicePixelRatio,
    cores: navigator.hardwareConcurrency ?? null,
  })
}