/**
 * 图片格式归一化。
 *
 * 为什么需要：Files API 的 `image` 块只接受 jpeg/png，而相册/微信导出的图片大量是 webp
 * （还有 bmp、gif、tiff、avif）。原样上传时服务端会回
 * `You have uploaded an unsupported image …`，而且这个 file_id 会跟着历史一直重发——
 * 于是一个长会话里只要夹带过一张 webp，之后每次发送都会失败，短会话却看不出来。
 *
 * 做法：非 jpeg/png 的图片在**上传前**用 canvas 转成 JPEG；顺带把长边压到 2048 以内
 * （省流量也省视觉 token）。解码失败时抛 ImageConvertError，由调用方决定怎么降级。
 */

/** 服务端明确支持的两种图片格式 */
const SUPPORTED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png'])

/** 长边上限：再大对识别没帮助，只会更慢更贵 */
const MAX_EDGE = 2048

/**
 * 总像素上限（约 40 MP）。
 *
 * 必须有这条闸：解码后的位图按 RGBA 常驻内存，20000×20000 就是约 1.49 GiB，
 * 老设备上直接 OOM。所以要在**解码之前**从文件头读出尺寸来拦。
 */
const MAX_PIXELS = 40_000_000

/**

/** JPEG 质量：0.9 在截图上肉眼无损 */
const JPEG_QUALITY = 0.9

export class ImageConvertError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ImageConvertError'
  }
}

export type NormalizedImage = {
  blob: Blob
  /** 转换后的文件名（扩展名跟着格式走，服务端也会看文件名） */
  name: string
  /** 是否真的转换过（用于日志与断言） */
  converted: boolean
}

const withJpegName = (name: string) => `${name.replace(/\.[^.]+$/, '')}.jpg`

/**
 * 解码一张图，拿到可画进 canvas 的源。
 *
 * 两条通路：
 * 1. `createImageBitmap`（Chrome 50+，走解码器，快）
 * 2. `<img>` + object URL（老 WebView 没有 createImageBitmap 时唯一可用的路；
 *    这条能解 webp / bmp / gif，正是老设备上报「图片格式不支持」的根因）
 */
type Drawable = { source: CanvasImageSource; width: number; height: number; close: () => void }

const loadViaImageElement = (blob: Blob): Promise<Drawable> =>
  new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob)
    const image = new Image()
    const cleanup = () => URL.revokeObjectURL(url)
    image.onload = () => {
      resolve({
        source: image,
        width: image.naturalWidth || image.width,
        height: image.naturalHeight || image.height,
        close: cleanup,
      })
    }
    image.onerror = () => {
      cleanup()
      reject(new ImageConvertError('图片无法解码'))
    }
    image.src = url
  })

const loadDrawable = async (blob: Blob): Promise<Drawable> => {
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(blob)
      return {
        source: bitmap,
        width: bitmap.width,
        height: bitmap.height,
        close: () => bitmap.close(),
      }
    } catch {
      // 解码器不认这个格式（老 WebView 常见）：退回 <img>
    }
  }
  if (typeof Image === 'undefined') {
    throw new ImageConvertError('图片无法解码')
  }
  return loadViaImageElement(blob)
}

/**
 * 读文件头字节。
 *
 * `Blob.arrayBuffer()` 要 Chrome 76+；老 WebView 上没有，直接调用会让**所有**图片在
 * 进入 `<img>` 兜底之前就失败，所以这里用 FileReader 兜一层。
 */
const readHeadBytes = (blob: Blob, bytes: number): Promise<Uint8Array> => {
  const part = blob.slice(0, bytes)
  if (typeof part.arrayBuffer === 'function') {
    return part.arrayBuffer().then((buffer) => new Uint8Array(buffer))
  }
  return new Promise((resolve, reject) => {
    if (typeof FileReader !== 'function') {
      reject(new ImageConvertError('图片无法解码'))
      return
    }
    const reader = new FileReader()
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer))
    reader.onerror = () => reject(new ImageConvertError('图片无法解码'))
    reader.readAsArrayBuffer(part)
  })
}

/**
 * BMP：按 DIB 头长度选布局。
 *
 * - 12 字节 `BITMAPCOREHEADER`（OS/2 v1）：宽高是 **16 位**，在 18 / 20
 * - 40 字节起 `BITMAPINFOHEADER` 及以后：宽高是 32 位有符号，在 18 / 22（高度可为负）
 *
 * 只按 32 位读会把 16×16 的 core header 图读成天文数字，误判成超大图拒掉。
 */
const probeBmp = (head: Uint8Array, view: DataView): { width: number; height: number } | null => {
  if (head.length < 26 || head[0] !== 0x42 || head[1] !== 0x4d) {
    return null
  }
  const dibSize = view.getUint32(14, true)
  if (dibSize === 12) {
    const width = view.getUint16(18, true)
    const height = view.getUint16(20, true)
    return width > 0 && height > 0 ? { width, height } : null
  }
  const width = Math.abs(view.getInt32(18, true))
  const height = Math.abs(view.getInt32(22, true))
  return width > 0 && height > 0 ? { width, height } : null
}

/**
 * JPEG：按段长度**跳读**找 SOF，不受 1 MB 头窗口限制。
 *
 * 为什么必须这么做：`APPn` / ICC / EXIF 段可以有几 MB，一张 1.9 MB 的 8192×8192 JPEG
 * 其 SOF 完全可能在 1 MiB 之后。只读头部会得出「尺寸未知」，而字节闸（24 MB）又拦不住它，
 * 结果就是把 268 MP 的位图交给解码器。这里逐段 `slice` 只读 16 字节，成本是常数级。
 *
 * 找不到 SOF（超过 `limit` 段）返回 null，由调用方拒绝全尺寸解码。
 */
const probeJpegSize = async (
  blob: Blob,
  limit = 512
): Promise<{ width: number; height: number } | null> => {
  let at = 2
  for (let step = 0; step < limit && at + 4 <= blob.size; step += 1) {
    let window = await readHeadBytes(blob.slice(at, Math.min(at + 16, blob.size)), 16)
    if (window.length < 2) {
      return null
    }
    if (window[0] !== 0xff) {
      return null
    }
    let cursor = 0
    // `FF` 填充可以比 16 字节窗口更长：窗口内跑完就往后挪一点继续跳，
    // 否则合法 JPEG 会在跳过填充时被判成「尺寸未知」而误拒。
    for (;;) {
      while (cursor + 1 < window.length && window[cursor + 1] === 0xff) {
        cursor += 1
      }
      if (cursor + 1 < window.length) {
        break
      }
      at += cursor
      if (at + 4 > blob.size) {
        return null
      }
      window = await readHeadBytes(blob.slice(at, Math.min(at + 16, blob.size)), 16)
      if (window.length < 2 || window[0] !== 0xff) {
        return null
      }
      cursor = 0
    }
    const marker = window[cursor + 1]
    // 无长度的独立标记
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      at += cursor + 2
      continue
    }
    if (cursor + 4 > window.length) {
      // 段长被窗口截断：把 at 挪到标记处重读一个完整窗口，别当成「尺寸未知」
      at += cursor
      continue
    }
    const size = (window[cursor + 2] << 8) | window[cursor + 3]
    if (size < 2) {
      return null
    }
    const isSof =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
    if (isSof) {
      // SOF 里高度在段内 3..5、宽度在 5..7（相对段起点，含长度字段）
      const body = await readHeadBytes(blob.slice(at + cursor, Math.min(at + cursor + 16, blob.size)), 16)
      if (body.length < 9) {
        return null
      }
      return { height: (body[5] << 8) | body[6], width: (body[7] << 8) | body[8] }
    }
    at += cursor + 2 + size
  }
  return null
}


/**
 * 从文件头读尺寸，**不解码**。
 *
 * 只为在解码前拦住超大图：解码后的位图按 RGBA 常驻，20000×20000 约 1.49 GiB。
 * 认得 PNG / JPEG / GIF / WebP / BMP；认不出、读头失败、或头被截断都返回 null，
 * 由调用方按「未知尺寸」保守处理。
 */
const probeImageSize = async (blob: Blob): Promise<{ width: number; height: number } | null> => {
  let head: Uint8Array
  try {
    // JPEG 的 SOF 段可能在 APPn/EXIF 之后很远，给 1 MB
    head = await readHeadBytes(blob, 1024 * 1024)
  } catch {
    return null
  }
  if (head.length < 26) {
    return null
  }
  try {
    return probeHead(head)
  } catch {
    // 头被截断时 DataView 会抛 RangeError：当作「尺寸未知」而不是失败
    return null
  }
}

const probeHead = (head: Uint8Array): { width: number; height: number } | null => {
  const view = new DataView(head.buffer, head.byteOffset, head.byteLength)
  // PNG：IHDR 宽高在 16..24
  if (head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) {
    return { width: view.getUint32(16), height: view.getUint32(20) }
  }
  // GIF：逻辑屏幕宽高在 6..10（小端）
  if (head[0] === 0x47 && head[1] === 0x49 && head[2] === 0x46) {
    return { width: head[6] | (head[7] << 8), height: head[8] | (head[9] << 8) }
  }
  // WebP：RIFF....WEBP 后是 VP8X / VP8 / VP8L 三种头；每种先把最短长度核掉再读
  if (head[0] === 0x52 && head[1] === 0x49 && head[2] === 0x46 && head[3] === 0x46) {
    const chunk = String.fromCharCode(head[12], head[13], head[14], head[15])
    if (chunk === 'VP8X' && head.length >= 30) {
      return {
        width: 1 + (head[24] | (head[25] << 8) | (head[26] << 16)),
        height: 1 + (head[27] | (head[28] << 8) | (head[29] << 16)),
      }
    }
    if (chunk === 'VP8 ' && head.length >= 30) {
      // VP8 的宽高是 14 位**小端**（RFC 6386）；按大端读会把 8192 读成 32，绕过上限
      return { width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff }
    }
    if (chunk === 'VP8L' && head.length >= 25) {
      const bits = head[21] | (head[22] << 8) | (head[23] << 16) | (head[24] << 24)
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 }
    }
  }
  const bmp = probeBmp(head, view)
  if (bmp !== null) {
    return bmp
  }
  // JPEG：扫段找 SOF0..SOF3 / SOF5..SOF7 / SOF9..SOF11 / SOF13..SOF15
  if (head[0] === 0xff && head[1] === 0xd8) {
    let at = 2
    while (at + 9 < head.length) {
      if (head[at] !== 0xff) {
        // 段之间理论上不允许出现非 0xFF，真出现就往下找下一个标记
        at += 1
        continue
      }
      // 跳过 0xFF 填充字节
      let markerAt = at
      while (markerAt + 1 < head.length && head[markerAt + 1] === 0xff) {
        markerAt += 1
      }
      const marker = head[markerAt + 1]
      // 无长度的独立标记：RSTn / SOI / EOI
      if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
        at = markerAt + 2
        continue
      }
      const size = (head[markerAt + 2] << 8) | head[markerAt + 3]
      const isSof =
        marker >= 0xc0 &&
        marker <= 0xcf &&
        marker !== 0xc4 &&
        marker !== 0xc8 &&
        marker !== 0xcc
      if (isSof && size >= 7) {
        return {
          height: (head[markerAt + 5] << 8) | head[markerAt + 6],
          width: (head[markerAt + 7] << 8) | head[markerAt + 8],
        }
      }
      // 长度字段至少 2 字节；异常值直接放弃探测（交给解码阶段的像素闸）
      if (size < 2) {
        break
      }
      at = markerAt + 2 + size
    }
  }
  return null
}

/** 用 canvas 把任意可解码的图片画成 JPEG；没有 canvas 的环境返回 null */
const drawToJpeg = async (blob: Blob): Promise<Blob | null> => {
  if (typeof document === 'undefined') {
    return null
  }
  const drawable = await loadDrawable(blob)
  try {
    const scale = Math.min(1, MAX_EDGE / Math.max(drawable.width, drawable.height))
    const width = Math.max(1, Math.round(drawable.width * scale))
    const height = Math.max(1, Math.round(drawable.height * scale))
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d')
    if (!context) {
      return null
    }
    // JPEG 没有透明通道，先铺白底，否则透明区会变成黑色
    context.fillStyle = '#fff'
    context.fillRect(0, 0, width, height)
    context.drawImage(drawable.source, 0, 0, width, height)
    const output = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob((result) => resolve(result), 'image/jpeg', JPEG_QUALITY)
    })
    if (output === null) {
      throw new ImageConvertError('图片转换失败')
    }
    return output
  } finally {
    // 无论画布、drawImage 还是 toBlob 抛错都要释放位图 / object URL
    drawable.close()
  }
}

/**
 * 把图片变成服务端能吃的格式。
 *
 * 三种情况：
 * - 已经是 jpeg/png 且头信息显示尺寸达标：**不重新编码、不解码**，直接返回
 * - 别的格式，或尺寸过大：解码一次、压到 2048 以内、转成 JPEG
 * - 头信息读不出尺寸（少见格式 / JPEG 的 SOF 太靠后）：按字节上限把关后再解码
 *
 * 两道闸都在**解码之前**：`MAX_PIXELS`（像素，按文件头算）与 `MAX_BYTES`（字节，兜住
 * 读不出尺寸的情况）。解码后的位图按 RGBA 常驻，20000×20000 约 1.49 GiB，老设备直接 OOM。
 */
export const toSupportedImage = async (blob: Blob, name: string): Promise<NormalizedImage> => {
  let probed = await probeImageSize(blob)
  const head = await readHeadBytes(blob.slice(0, 2), 2).catch(() => new Uint8Array())
  const isJpeg = head.length >= 2 && head[0] === 0xff && head[1] === 0xd8
  // JPEG 的头窗口可能读不到 SOF（EXIF/ICC 段很大）：按段跳读再确认一次
  if (probed === null && isJpeg) {
    probed = await probeJpegSize(blob)
  }
  if (probed !== null && probed.width * probed.height > MAX_PIXELS) {
    throw new ImageConvertError('图片尺寸过大')
  }
  const supported = SUPPORTED_IMAGE_TYPES.has(blob.type)
  const fits = probed !== null && Math.max(probed.width, probed.height) <= MAX_EDGE
  if (supported && fits) {
    return { blob, name, converted: false }
  }
  // 仍读不出像素数：容器结构不可信（段数过多、长度字段异常、或不认识的格式）。
  // 宁可明确拒绝，也不把未知大小的位图交给解码器——那是一台老设备最容易被 OOM 杀掉的地方。
  if (probed === null) {
    throw new ImageConvertError(isJpeg ? '图片尺寸过大' : '图片格式无法识别')
  }
  const jpeg = await drawToJpeg(blob)
  if (jpeg === null) {
    // 没有 canvas（Node）：原样返回，让服务端去判
    return { blob, name, converted: false }
  }
  return { blob: jpeg, name: withJpegName(name), converted: true }
}

/**
 * 判断一张图片是不是「大概率会被服务端拒绝」的格式。
 * 空 MIME（导入的历史附件常见）也算可疑：宁可从上下文里退化成文件名，
 * 也不要让整个会话发不出去。
 */
export const isRiskyImageType = (mime: string): boolean => !SUPPORTED_IMAGE_TYPES.has(mime)
