/**
 * 把磁盘上的归档当 Blob 用：`fs.openAsBlob` 和浏览器里的 `File` 一样支持懒切片，
 * 工具里因此能跑到与真机相同的代码路径（含 `sliceBlob` 零拷贝那条）。
 */
import { openAsBlob } from 'node:fs'

/**
 * @param {string} path 归档路径
 * @param {(bytes: number) => void} [onRead] 每次切片时回报读了多少字节
 */
export const openFileSource = async (path, onRead) => {
  const blob = await openAsBlob(path)
  const slice = (start, end) => {
    const part = blob.slice(start, end)
    onRead?.(part.size)
    return part
  }
  return { size: blob.size, slice, sliceBlob: slice }
}
