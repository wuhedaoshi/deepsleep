/**
 * 导出运行日志成文本文件。
 *
 * 手机上复用「导出历史」那条原生保存链路（SAF 选位置 → 分块写盘），
 * 只是这里写的是一段文本而不是 ZIP；桌面浏览器退回 Blob 下载。
 */
import { canSaveToDisk, saveArchive } from './chat/history/archiveSink.js'
import { describeEnvironment, formatLog, logInfo } from './log.js'

const fileName = () => {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
  return `deepsleep-log-${stamp}.txt`
}

/** 环境摘要放在文件头：排查时第一眼要的机型、WebView 版本、视口 */
const header = () =>
  [
    '# Deepsleep 运行日志',
    '# 只记录事件与计数，不含对话内容与 API Key',
    ...Object.entries(describeEnvironment()).map(([key, value]) => `# ${key}: ${String(value)}`),
    '',
  ].join('\n')

/** 原生侧日志尾巴（onCreate / onPageFinished / renderer 等），拿不到就是空串 */
const nativeTail = (): string => {
  const bridge = (window as { __deepsleepNative?: { readLogTail?: (n: number) => string } })
    .__deepsleepNative
  try {
    const text = bridge?.readLogTail?.(60_000) ?? ''
    return typeof text === 'string' ? text : ''
  } catch {
    return ''
  }
}

/** 导出日志，返回落点（原生）或空串（浏览器下载） */
export const exportLog = async (): Promise<string> => {
  const tail = nativeTail()
  const text = [
    header(),
    formatLog(),
    '',
    '## 原生日志（WebView 生命周期）',
    tail === '' ? '(无)' : tail,
    '',
  ].join('\n')
  logInfo('log', `导出日志，共 ${formatLog().split('\n').length} 行`)
  if (canSaveToDisk()) {
    const bytes = new TextEncoder().encode(text)
    const path = await saveArchive(fileName(), async (sink) => {
      await sink(bytes)
    })
    return path ?? ''
  }
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName()
  anchor.click()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
  return ''
}
