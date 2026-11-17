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

/** 用 canvas 把任意可解码的图片画成 JPEG；Node 等没有 canvas 的环境返回 null */
const drawToJpeg = async (blob: Blob): Promise<Blob | null> => {
  if (typeof document === 'undefined' || typeof createImageBitmap !== 'function') {
    return null
  }
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(blob)
  } catch {
    throw new ImageConvertError('图片无法解码')
  }
  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height))
  const width = Math.max(1, Math.round(bitmap.width * scale))
  const height = Math.max(1, Math.round(bitmap.height * scale))
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d')
  if (!context) {
    bitmap.close()
    return null
  }
  // JPEG 没有透明通道，先铺白底，否则透明区会变成黑色
  context.fillStyle = '#fff'
  context.fillRect(0, 0, width, height)
  context.drawImage(bitmap, 0, 0, width, height)
  bitmap.close()
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
 * 已经是 jpeg/png 且尺寸不超限时原样返回（不重新编码，避免无谓掉质量）。
 */
export const toSupportedImage = async (blob: Blob, name: string): Promise<NormalizedImage> => {
  const supported = SUPPORTED_IMAGE_TYPES.has(blob.type)
  // 尺寸未知时（Node / 老 WebView）只按 MIME 判断
  let oversized = false
  if (supported && typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(blob)
      oversized = Math.max(bitmap.width, bitmap.height) > MAX_EDGE
      bitmap.close()
    } catch {
      // 解不开就交给下面的转换分支处理
      oversized = true
    }
  }
  if (supported && !oversized) {
    return { blob, name, converted: false }
  }
  const jpeg = await drawToJpeg(blob)
  if (jpeg === null) {
    // 没有 canvas（Node / 老 WebView）：原样返回，让服务端去判，至少不比现在更差
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
