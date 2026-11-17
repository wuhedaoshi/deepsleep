/**
 * 把导出的 ZIP 分块写进用户通过 SAF 选定的位置。
 *
 * 为什么需要它：WebView 里 `URL.createObjectURL(blob)` + `a.click()` 什么都不会发生——
 * `MainActivity` 没有 `DownloadListener`，这就是「导出所有历史对话点了没反应」的原因。
 * 所以 APK 里的导出必须由原生侧落盘，另一个 App（同机实验线）或官方网页版才拿得到文件去导入。
 *
 * 协议（`window.__deepsleepNative`，全部同步返回）：
 *
 * | 方法 | 语义 |
 * |---|---|
 * | `beginArchiveSave(name)` | 拉起 `ACTION_CREATE_DOCUMENT`，立即返回是否已受理 |
 * | `isArchiveSaveReady()` | 用户选完位置、输出流已打开时为 true |
 * | `getArchiveSaveError()` | 失败原因；空串表示还没失败（包含「用户正在选位置」） |
 * | `writeArchiveChunk(base64)` | true = 已收下；false = 未就绪 / 队列满 / 已失败，调用方退一步重试 |
 * | `finishArchiveSave()` | flush + close，返回落点；失败返回空串 |
 * | `abortArchiveSave()` | 丢弃队列、关流、删掉半成品文件 |
 *
 * 三处容易踩空的地方：
 * 1. 桥方法在 WebView 的 JavaBridge 线程上同步返回，**写盘发生在原生侧的另一条线程**，
 *    所以 `writeArchiveChunk` 会因队列满而返回 false —— 这是背压，不是错误，重试即可。
 * 2. 用户可能在 SAF 界面里点取消，也可能一直不选：所以要轮询 + 超时，超时就 abort。
 * 3. 没有桥（桌面浏览器、还没加桥的旧 APK）时 `canSaveToDisk()` 为 false，
 *    调用方退回原来的 Blob 下载。
 */
import type { ChunkSink } from './exportArchive.js'

/** 原生桥对象。缺任意一个必需方法就当作没有桥。 */
type NativeSink = {
  beginArchiveSave: (name: string) => boolean
  isArchiveSaveReady: () => boolean
  getArchiveSaveError?: () => string
  writeArchiveChunk: (base64: string) => boolean
  finishArchiveSave: () => string
  abortArchiveSave: () => void
}

/** 单次交给原生桥的原文大小。base64 后约 683 KiB，WebView 的 JS 桥吃得下这个量级。 */
const CHUNK_BYTES = 512 * 1024
/** 等用户选位置：50 ms 一次。 */
const READY_POLL_MS = 50
/** 用户 120 s 还没选完就认输（SAF 界面卡住、或结果回调丢了）。 */
const READY_TIMEOUT_MS = 120_000
/** 原生写队列满时退一步再试。 */
const BUSY_RETRY_MS = 4
/** 连续这么久都塞不进去，说明写线程卡死了（磁盘满、provider 挂了）。 */
const BUSY_TIMEOUT_MS = 60_000
/** 每写这么多字节让出一次主线程，进度条和按钮才刷得动。 */
const YIELD_BYTES = 16 * 1024 * 1024
/** `String.fromCharCode` 一次吃 8 KiB：再大就有爆栈风险，再小则拼接次数太多。 */
const CODE_CHUNK = 8 * 1024

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

const nativeSink = (): NativeSink | undefined => {
  const bridge = (window as unknown as { __deepsleepNative?: Partial<NativeSink> })
    .__deepsleepNative
  if (bridge === undefined) {
    return undefined
  }
  if (
    typeof bridge.beginArchiveSave !== 'function' ||
    typeof bridge.isArchiveSaveReady !== 'function' ||
    typeof bridge.writeArchiveChunk !== 'function' ||
    typeof bridge.finishArchiveSave !== 'function' ||
    typeof bridge.abortArchiveSave !== 'function'
  ) {
    return undefined
  }
  // 上面已经逐项确认过类型；取一份「必需方法齐全」的视图，下面的箭头函数只负责保住接收者。
  const sink = bridge as Required<NativeSink>
  // 注意：**不能**把方法解构出来再调用。Chromium 的注入对象不是普通 JS 对象，
  // 方法要靠接收者（this）才能定位到对应的 Java 实例；`const { f } = bridge; f()`
  // 会丢接收者，直接抛 “Java bridge method can't be invoked on a non-injected object”。
  // 所以这里一律通过 sink（就是 bridge 本身）调用。
  return {
    beginArchiveSave: (name) => sink.beginArchiveSave(name),
    isArchiveSaveReady: () => sink.isArchiveSaveReady(),
    writeArchiveChunk: (base64) => sink.writeArchiveChunk(base64),
    finishArchiveSave: () => sink.finishArchiveSave(),
    abortArchiveSave: () => sink.abortArchiveSave(),
    getArchiveSaveError:
      typeof sink.getArchiveSaveError === 'function'
        ? () => (sink.getArchiveSaveError as () => string)()
        : undefined,
  }
}

/** 手机上（APK）为 true：导出必须走原生落盘，`a.click()` 在 WebView 里是空操作。 */
export const canSaveToDisk = (): boolean => nativeSink() !== undefined

const reasonOf = (sink: NativeSink): string => {
  const read = sink.getArchiveSaveError
  if (read === undefined) {
    return ''
  }
  const reason = read()
  return typeof reason === 'string' ? reason : ''
}

/** 等到原生侧把流打开：用户点「保存」、点取消、或者一直不选，三种都要能出去。 */
const waitUntilReady = async (sink: NativeSink): Promise<void> => {
  const deadline = Date.now() + READY_TIMEOUT_MS
  while (!sink.isArchiveSaveReady()) {
    const reason = reasonOf(sink)
    if (reason !== '') {
      throw new Error(`archive save failed: ${reason}`)
    }
    if (Date.now() > deadline) {
      throw new Error('archive save failed: timed out waiting for the file location')
    }
    await sleep(READY_POLL_MS)
  }
}

/** 分块 base64：整个 ZIP 永远不会变成一个字符串。 */
const encodeBase64 = (bytes: Uint8Array): string => {
  let binary = ''
  for (let at = 0; at < bytes.length; at += CODE_CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(at, at + CODE_CHUNK))
  }
  return btoa(binary)
}

/** 写一块；原生队列满时重试。只有原生侧明确失败或流被关掉才抛错。 */
const writeChunk = async (sink: NativeSink, bytes: Uint8Array<ArrayBuffer>): Promise<void> => {
  const encoded = encodeBase64(bytes)
  const deadline = Date.now() + BUSY_TIMEOUT_MS
  while (!sink.writeArchiveChunk(encoded)) {
    const reason = reasonOf(sink)
    if (reason !== '') {
      throw new Error(`archive save failed: ${reason}`)
    }
    if (!sink.isArchiveSaveReady()) {
      throw new Error('archive save failed: the output stream closed')
    }
    if (Date.now() > deadline) {
      throw new Error('archive save failed: the native writer stopped draining')
    }
    await sleep(BUSY_RETRY_MS)
  }
}

/**
 * 让 `run` 把 ZIP 字节推进用户选定的文件，返回落点路径。
 *
 * 没有原生桥时返回 `undefined`，调用方退回 Blob 下载；有桥但失败（用户取消、写盘报错、
 * 等位置超时）一律抛错——**不要**把失败伪装成 `undefined`，那样调用方会以为还能走浏览器下载。
 */
export const saveArchive = async (
  name: string,
  run: (sink: ChunkSink) => Promise<void>
): Promise<string | undefined> => {
  const sink = nativeSink()
  if (sink === undefined) {
    return undefined
  }
  if (!sink.beginArchiveSave(name)) {
    const reason = reasonOf(sink)
    throw new Error(
      `archive save failed: ${
        reason === '' ? 'another save is still running, or the native bridge is busy' : reason
      }`
    )
  }
  let pending = 0
  const chunkSink: ChunkSink = async (chunk) => {
    for (let at = 0; at < chunk.length; at += CHUNK_BYTES) {
      const end = Math.min(at + CHUNK_BYTES, chunk.length)
      await writeChunk(sink, chunk.subarray(at, end))
    }
    pending += chunk.length
    if (pending >= YIELD_BYTES) {
      pending = 0
      // 让出一整个宏任务：渲染、按钮状态、进度文案都只能在这个间隙里更新。
      await sleep(0)
    }
  }
  try {
    await waitUntilReady(sink)
    await run(chunkSink)
    const path = sink.finishArchiveSave()
    if (typeof path !== 'string' || path === '') {
      const reason = reasonOf(sink)
      throw new Error(
        `archive save failed: ${reason === '' ? 'the native bridge closed without a path' : reason}`
      )
    }
    return path
  } catch (error) {
    // 半截 ZIP 没用：让原生侧关流并删掉，别在 Downloads 里留个坏文件。
    sink.abortArchiveSave()
    throw error
  }
}
