import { useEffect, useState } from 'react'
import {
  bootFailureCount,
  CRASH_LOOP_THRESHOLD,
  formatLog,
  logInfo,
  resetBootFailures,
} from '../services/log.js'
import { exportLog } from '../services/logExport.js'

/**
 * 连续启动失败时的恢复界面。
 *
 * 为什么需要：白屏时用户既进不了设置、也导不出日志，只能卸载重装（数据全丢）。
 * 这里在「上一版启动连着崩了 N 次」时抢在加载历史和渲染列表之前接管，
 * 只依赖最少的代码路径：不读 IndexedDB、不建 store，所以它自己几乎不会崩。
 */
export const RecoveryScreen = () => {
  const failures = bootFailureCount()
  const [saved, setSaved] = useState('')
  const [confirming, setConfirming] = useState(false)

  useEffect(() => {
    logInfo('boot', `进入恢复界面（连续异常 ${failures} 次）`)
  }, [failures])

  const save = async () => {
    try {
      const path = await exportLog()
      setSaved(path === '' ? '已导出到下载目录' : path)
    } catch {
      setSaved('导出失败，可改用文件管理器查看 Android/data/com.deepsleep.app/files/logs')
    }
  }

  const wipe = async () => {
    // 清 IndexedDB：本地会话与附件一起删掉；API Key 等设置保留，避免用户还得重填
    await new Promise<void>((resolve) => {
      const request = indexedDB.deleteDatabase('deepsleep')
      request.onsuccess = () => resolve()
      request.onerror = () => resolve()
      request.onblocked = () => resolve()
    })
    resetBootFailures()
    location.reload()
  }

  const retry = () => {
    resetBootFailures()
    location.reload()
  }

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        overflow: 'auto',
        padding: '28px 16px',
        background: '#0d1626',
        color: '#e5e7eb',
        font: '14px/1.7 -apple-system, "Segoe UI", system-ui, sans-serif',
      }}
    >
      <div style={{ maxWidth: 640, margin: '0 auto' }}>
        <h1 style={{ fontSize: 19, margin: '0 0 10px' }}>启动没走完，先停在这里</h1>
        <p style={{ margin: '0 0 14px', color: '#9ca3af' }}>
          最近连续 {failures} 次启动异常中断（多半是加载历史时内存不够或被系统回收）。
          这一页刻意不加载任何历史数据，所以一定能打开。
        </p>

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 18 }}>
          <button type="button" onClick={() => void save()} style={primary}>
            {saved === '' ? '导出日志' : saved}
          </button>
          <button type="button" onClick={retry} style={secondary}>
            再试一次
          </button>
          <button
            type="button"
            onClick={() => setConfirming(true)}
            style={danger}
          >
            清空本地会话
          </button>
        </div>

        {confirming ? (
          <div
            style={{
              border: '1px solid #7f1d1d',
              borderRadius: 12,
              padding: 14,
              marginBottom: 18,
              background: '#1a1114',
            }}
          >
            <div style={{ marginBottom: 10 }}>
              会删掉本机所有对话与图片附件（不可恢复）。设置与 API Key 保留。
              建议先「导出日志」，再决定要不要清。
            </div>
            <button type="button" onClick={() => void wipe()} style={danger}>
              确认清空并重启
            </button>
            <button
              type="button"
              onClick={() => setConfirming(false)}
              style={{ ...secondary, marginLeft: 8 }}
            >
              取消
            </button>
          </div>
        ) : null}

        <div style={{ color: '#9ca3af', margin: '0 0 6px' }}>
          日志文件（可用文件管理器直接翻）：
          <code style={{ wordBreak: 'break-all' }}>
            {' '}
            Android/data/com.deepsleep.app/files/logs/deepsleep.log
          </code>
        </div>
        <pre
          style={{
            maxHeight: '38vh',
            overflow: 'auto',
            margin: 0,
            padding: 12,
            background: '#111a2b',
            border: '1px solid #1f2937',
            borderRadius: 10,
            fontSize: 11,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          }}
        >
          {formatLog() || '(空)'}
        </pre>
      </div>
    </div>
  )
}

const base = {
  padding: '9px 15px',
  borderRadius: 999,
  fontSize: 13,
  cursor: 'pointer' as const,
  border: '1px solid #374151',
}
const primary = { ...base, background: '#1b2a4a', color: '#e5e7eb' }
const secondary = { ...base, background: 'transparent', color: '#e5e7eb' }
const danger = { ...base, background: '#7f1d1d', color: '#fee2e2', borderColor: '#7f1d1d' }

export const shouldShowRecovery = () => bootFailureCount() >= CRASH_LOOP_THRESHOLD
