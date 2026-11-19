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

/** 用 canvas 把任意可解码的图片画成 JPEG；没有 canvas 的环境返回 null */
const drawToJpeg = async (blob: Blob): Promise<Blob | null> => {
  if (typeof document === 'undefined') {
    return null
  }
  const drawable = await loadDrawable(blob)
  const scale = Math.min(1, MAX_EDGE / Math.max(drawable.width, drawable.height))
  const width = Math.max(1, Math.round(drawable.width * scale))
  const height = Math.max(1, Math.round(drawable.height * scale))
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d')
  if (!context) {
    drawable.close()
    return null
  }
  // JPEG 没有透明通道，先铺白底，否则透明区会变成黑色
  context.fillStyle = '#fff'
  context.fillRect(0, 0, width, height)
  context.drawImage(drawable.source, 0, 0, width, height)
  drawable.close()
  const output = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob((result) => resolve(result), 'image/jpeg', JPEG_QUALITY)
  })
  if (output === null) {
    throw new ImageConvertError('图片转换失败')
  }
  return output
}

/**
 * 把图片变成服务端能吃的格式。
 *
 * 已经是 jpeg/png 且尺寸不超限时原样返回（不重新编码，避免无谓掉质量）。
 * 尺寸判断走 `loadDrawable`：老 WebView 没有 `createImageBitmap` 时也能量出长边，
 * 否则超大 PNG 会带着原尺寸上传，服务端同样会拒。
 */
export const toSupportedImage = async (blob: Blob, name: string): Promise<NormalizedImage> => {
  const supported = SUPPORTED_IMAGE_TYPES.has(blob.type)
  let oversized = false
  let decodable = true
  if (supported) {
    try {
      const drawable = await loadDrawable(blob)
      oversized = Math.max(drawable.width, drawable.height) > MAX_EDGE
      drawable.close()
    } catch {
      // 解不开就交给下面的转换分支；再失败会让调用方给出明确提示
      decodable = false
    }
  }
  if (supported && decodable && !oversized) {
    return { blob, name, converted: false }
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
