/**
 * 只读 ZIP 解析，为大归档逐条读设计：
 * - 中央目录只读一次，之后按需 `Blob.slice` 取单个 entry 的数据段，任何时刻都不持有整包字节；
 * - deflate 解压按 1 MiB 窗口流入回调，只有 JSON 才需要拼成完整字符串；
 * - 不支持加密、ZIP64、分卷，遇到直接报错。
 *
 * 之所以不用 fflate 的 `unzipSync`：那需要整包 Uint8Array，450 MB 的归档在手机上直接出局。
 */

/** `Blob` 的最小可用子集；单测可以换成基于文件的实现。 */
export type ZipSource = {
  readonly size: number
  slice(start: number, end: number): Blob
  /**
   * 直接切出一段 Blob，不经过 JS 堆。`File` / `Blob` 天然支持；
   * 文件系统来源没有这个能力，此时退回「读字节 → new Blob」。
   */
  sliceBlob?(start: number, end: number): Blob
}

export type ZipEntry = {
  name: string
  /** 0 = store，8 = deflate */
  method: number
  crc32: number
  compressedSize: number
  /** 解压后字节数 */
  size: number
  /** 中央目录里记录的局部头偏移 */
  headerOffset: number
}

/** fflate 的 `Inflate` 只用到这两个动作，收窄成接口便于测试注入其他实现。 */
export type InflateStream = { push(chunk: Uint8Array, final: boolean): void }
export type CreateInflate = (onData: (chunk: Uint8Array) => void) => InflateStream

export type ZipErrorCode =
  | 'notZip'
  | 'truncated'
  | 'unsupported'
  | 'encrypted'
  | 'noEntry'
  | 'corrupt'

export class ZipError extends Error {
  readonly code: ZipErrorCode

  constructor(code: ZipErrorCode, detail?: string) {
    super(detail === undefined ? code : `${code}: ${detail}`)
    this.name = 'ZipError'
    this.code = code
  }
}

const LOCAL_HEADER = 0x04034b50
const CENTRAL_HEADER = 0x02014b50
const END_OF_CENTRAL_DIR = 0x06054b50
const MAX_COMMENT = 0xffff
const ZIP64_MARK = 0xffffffff

/** 单次读取的压缩字节数。1 MiB 在手机上约 1 ms，够摊薄 slice 的固定开销又不占堆。 */
const WINDOW = 1 << 20

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1
    }
    table[index] = value >>> 0
  }
  return table
})()

const crc32 = (chunks: readonly Uint8Array[], seed = 0xffffffff): number => {
  let crc = seed
  for (const chunk of chunks) {
    for (let index = 0; index < chunk.length; index += 1) {
      crc = CRC_TABLE[(crc ^ chunk[index]) & 0xff] ^ (crc >>> 8)
    }
  }
  return crc
}

const decodeName = (bytes: Uint8Array, utf8: boolean): string => {
  if (utf8) {
    return new TextDecoder('utf-8').decode(bytes)
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    // 老工具写的归档可能是 CP437；这里退到 latin1，中文名会乱码但不会整包失败。
    return new TextDecoder('latin1').decode(bytes)
  }
}

const dataView = (bytes: Uint8Array): DataView =>
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

/**
 * 把解压产物收成「数组缓冲区独占」的视图：fflate 给的可能是 SharedArrayBuffer 上的视图，
 * `Blob` 构造不接受。走视图不需要拷贝，只有真的落在 SharedArrayBuffer 上时才复制一份。
 */
export const ownedBytes = (chunk: Uint8Array): Uint8Array<ArrayBuffer> => {
  if (chunk.buffer instanceof ArrayBuffer) {
    return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)
  }
  const copy = new Uint8Array(chunk.byteLength)
  copy.set(chunk)
  return copy
}

/** 从压缩包尾部找中央目录结束记录；归档末尾可能有最长 64 KB 的注释。 */
const findEndOfCentralDir = (tail: Uint8Array, tailOffset: number, fileSize: number): number => {
  const view = dataView(tail)
  for (let index = tail.length - 22; index >= 0; index -= 1) {
    if (view.getUint32(index, true) !== END_OF_CENTRAL_DIR) {
      continue
    }
    const commentLength = view.getUint16(index + 20, true)
    if (index + 22 + commentLength === tail.length) {
      return tailOffset + index
    }
  }
  throw new ZipError('notZip', `no end of central directory in ${fileSize} bytes`)
}

export class ZipArchive {
  private readonly source: ZipSource
  private readonly byName: Map<string, ZipEntry>
  private readonly dataOffsets = new Map<string, number>()
  private inflateFactory: CreateInflate | null

  private constructor(
    source: ZipSource,
    entries: ZipEntry[],
    inflateFactory: CreateInflate | null
  ) {
    this.source = source
    this.byName = new Map(entries.map((entry) => [entry.name, entry]))
    this.inflateFactory = inflateFactory
  }

  /**
   * 只读中央目录建索引，不做任何解压。`createInflate` 缺省时按需动态载入 fflate，
   * 传入自定义实现可以在 Node 里用 `zlib` 跑同一套逻辑。
   */
  static async open(source: ZipSource, createInflate?: CreateInflate): Promise<ZipArchive> {
    if (source.size < 22) {
      throw new ZipError('notZip', 'shorter than an empty archive')
    }
    const tailStart = Math.max(0, source.size - 22 - MAX_COMMENT)
    const tail = new Uint8Array(await source.slice(tailStart, source.size).arrayBuffer())
    const endOffset = findEndOfCentralDir(tail, tailStart, source.size)
    const endView = dataView(tail)
    const endIndex = endOffset - tailStart
    const diskNumber = endView.getUint16(endIndex + 4, true)
    const centralDisk = endView.getUint16(endIndex + 6, true)
    const diskEntries = endView.getUint16(endIndex + 8, true)
    const totalEntries = endView.getUint16(endIndex + 10, true)
    const centralSize = endView.getUint32(endIndex + 12, true)
    const centralOffset = endView.getUint32(endIndex + 16, true)
    if (diskNumber !== 0 || centralDisk !== 0 || diskEntries !== totalEntries) {
      throw new ZipError('unsupported', 'multi-disk archive')
    }
    if (totalEntries === 0xffff || centralSize === ZIP64_MARK || centralOffset === ZIP64_MARK) {
      throw new ZipError('unsupported', 'zip64 archive')
    }
    if (centralOffset + centralSize > source.size) {
      throw new ZipError('truncated', 'central directory past end of file')
    }
    const central = new Uint8Array(
      await source.slice(centralOffset, centralOffset + centralSize).arrayBuffer()
    )
    if (central.length !== centralSize) {
      throw new ZipError('truncated', 'central directory shorter than declared')
    }
    const view = dataView(central)
    const entries: ZipEntry[] = []
    let cursor = 0
    for (let index = 0; index < totalEntries; index += 1) {
      if (cursor + 46 > central.length || view.getUint32(cursor, true) !== CENTRAL_HEADER) {
        throw new ZipError('corrupt', `central directory entry ${index}`)
      }
      const flags = view.getUint16(cursor + 8, true)
      const method = view.getUint16(cursor + 10, true)
      const crc = view.getUint32(cursor + 16, true)
      const compressedSize = view.getUint32(cursor + 20, true)
      const size = view.getUint32(cursor + 24, true)
      const nameLength = view.getUint16(cursor + 28, true)
      const extraLength = view.getUint16(cursor + 30, true)
      const commentLength = view.getUint16(cursor + 32, true)
      const headerOffset = view.getUint32(cursor + 42, true)
      const next = cursor + 46 + nameLength + extraLength + commentLength
      if (next > central.length) {
        throw new ZipError('corrupt', `central directory name ${index}`)
      }
      const rawName = central.subarray(cursor + 46, cursor + 46 + nameLength)
      const name = decodeName(rawName, (flags & 0x800) !== 0)
      if ((flags & 1) !== 0) {
        throw new ZipError('encrypted', name)
      }
      if (method !== 0 && method !== 8) {
        throw new ZipError('unsupported', `method ${method} for ${name}`)
      }
      if (compressedSize === ZIP64_MARK || size === ZIP64_MARK) {
        throw new ZipError('unsupported', `zip64 entry ${name}`)
      }
      if (!name.endsWith('/')) {
        entries.push({ name, method, crc32: crc, compressedSize, size, headerOffset })
      }
      cursor = next
    }
    return new ZipArchive(source, entries, createInflate ?? null)
  }

  get names(): string[] {
    return [...this.byName.keys()]
  }

  entry(name: string): ZipEntry | undefined {
    return this.byName.get(name)
  }

  has(name: string): boolean {
    return this.byName.has(name)
  }

  /** 读完整 entry；只用于体积可控的文本（会话 JSON、清单）。 */
  async read(name: string, verify = true): Promise<Uint8Array<ArrayBuffer>> {
    const chunks: Uint8Array<ArrayBuffer>[] = []
    let total = 0
    for await (const chunk of this.stream(name)) {
      chunks.push(chunk)
      total += chunk.length
    }
    const joined = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) {
      joined.set(chunk, offset)
      offset += chunk.length
    }
    const entry = this.require(name)
    if (verify && (crc32([joined]) ^ 0xffffffff) >>> 0 !== entry.crc32) {
      throw new ZipError('corrupt', `crc mismatch for ${name}`)
    }
    return joined
  }

  /**
   * store（不压缩）条目直接切成 Blob：图片都是 method 0，这样 300 MB 原件不必经过 JS 堆。
   * 来源不支持 `sliceBlob` 或条目是 deflate 时返回 `undefined`，由调用方退回读字节。
   */
  async storedBlob(name: string, type: string): Promise<Blob | undefined> {
    const entry = this.require(name)
    const sliceBlob = this.source.sliceBlob
    if (entry.method !== 0 || sliceBlob === undefined) {
      return undefined
    }
    const start = await this.entryDataOffset(entry)
    return sliceBlob.call(this.source, start, start + entry.compressedSize).slice(0, entry.size, type)
  }

  /** 只读 entry 的前若干字节：判断 MIME、生成缩略图时不必解完整份。 */
  async readHead(name: string, limit: number): Promise<Uint8Array<ArrayBuffer>> {
    const head: Uint8Array<ArrayBuffer>[] = []
    let total = 0
    for await (const chunk of this.stream(name)) {
      head.push(chunk)
      total += chunk.length
      if (total >= limit) {
        break
      }
    }
    const joined = new Uint8Array(Math.min(total, limit))
    let offset = 0
    for (const chunk of head) {
      if (offset >= joined.length) {
        break
      }
      const take = Math.min(chunk.length, joined.length - offset)
      joined.set(chunk.subarray(0, take), offset)
      offset += take
    }
    return joined
  }

  /** 逐窗口产出解压后的字节；调用方负责拼接或直接转 Blob。 */
  async *stream(name: string): AsyncGenerator<Uint8Array<ArrayBuffer>> {
    const entry = this.require(name)
    const start = await this.entryDataOffset(entry)
    const end = start + entry.compressedSize
    if (entry.method === 0) {
      let cursor = start
      while (cursor < end) {
        const next = Math.min(cursor + WINDOW, end)
        yield new Uint8Array(await this.source.slice(cursor, next).arrayBuffer())
        cursor = next
      }
      return
    }
    const createInflate = await this.inflate()
    const pending: Uint8Array<ArrayBuffer>[] = []
    let produced = 0
    const inflate = createInflate((chunk) => {
      pending.push(ownedBytes(chunk))
      produced += chunk.length
    })
    let cursor = start
    while (cursor < end) {
      const next = Math.min(cursor + WINDOW, end)
      const compressed = new Uint8Array(await this.source.slice(cursor, next).arrayBuffer())
      if (compressed.length === 0) {
        throw new ZipError('truncated', name)
      }
      inflate.push(compressed, next === end)
      cursor = next
      while (pending.length > 0) {
        const chunk = pending.shift()
        if (chunk !== undefined && chunk.length > 0) {
          yield chunk
        }
      }
    }
    if (produced !== entry.size) {
      throw new ZipError('corrupt', `${name}: ${produced} of ${entry.size} bytes inflated`)
    }
  }

  private require(name: string): ZipEntry {
    const entry = this.byName.get(name)
    if (!entry) {
      throw new ZipError('noEntry', name)
    }
    return entry
  }

  /** 局部头的 name/extra 长度可能与中央目录不同，数据偏移必须按局部头现算。 */
  private async entryDataOffset(entry: ZipEntry): Promise<number> {
    const cached = this.dataOffsets.get(entry.name)
    if (cached !== undefined) {
      return cached
    }
    const header = new Uint8Array(
      await this.source.slice(entry.headerOffset, entry.headerOffset + 30).arrayBuffer()
    )
    if (header.length !== 30) {
      throw new ZipError('truncated', entry.name)
    }
    const view = dataView(header)
    if (view.getUint32(0, true) !== LOCAL_HEADER) {
      throw new ZipError('corrupt', `local header of ${entry.name}`)
    }
    const offset =
      entry.headerOffset + 30 + view.getUint16(26, true) + view.getUint16(28, true)
    if (offset + entry.compressedSize > this.source.size) {
      throw new ZipError('truncated', entry.name)
    }
    this.dataOffsets.set(entry.name, offset)
    return offset
  }

  private async inflate(): Promise<CreateInflate> {
    if (this.inflateFactory === null) {
      const { Inflate } = await import('fflate')
      this.inflateFactory = (onData) => {
        const stream = new Inflate((chunk) => {
          onData(chunk)
        })
        return { push: (chunk, final) => stream.push(chunk, final) }
      }
    }
    return this.inflateFactory
  }
}
