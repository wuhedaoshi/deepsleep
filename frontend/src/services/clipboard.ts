/**
 * 复制到剪贴板。
 *
 * 为什么不用 `navigator.clipboard` 就够了：WebView 里这个接口经常直接抛
 * `NotAllowedError`——没有 clipboard-write 授权，调用链也不保证是"用户手势"的
 * 直接延续（我们的复制按钮常常是先 await 一次导出、再复制）。用户看到的就是
 * 「复制失败」。所以顺序是：原生桥 → 异步剪贴板 API → 老式 execCommand。
 */

type NativeClipboard = { copyToClipboard?: (text: string) => boolean }

const viaNative = (text: string): boolean => {
  const bridge = (window as { __deepsleepNative?: NativeClipboard }).__deepsleepNative
  try {
    return bridge?.copyToClipboard?.(text) === true
  } catch {
    return false
  }
}

const viaExecCommand = (text: string): boolean => {
  try {
    const area = document.createElement('textarea')
    area.value = text
    // 必须在视口内且不被隐藏，否则 iOS/部分 WebView 会拒绝选中
    area.style.position = 'fixed'
    area.style.top = '0'
    area.style.left = '0'
    area.style.opacity = '0'
    document.body.appendChild(area)
    area.focus()
    area.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(area)
    return ok
  } catch {
    return false
  }
}

/** 返回是否复制成功；调用方据此给出提示 */
export const copyText = async (text: string): Promise<boolean> => {
  if (text === '') {
    return false
  }
  if (viaNative(text)) {
    return true
  }
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    // 继续退化到 execCommand
  }
  return viaExecCommand(text)
}
