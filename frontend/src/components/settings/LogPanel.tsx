import { useEffect, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { Button } from '../base/Button.js'
import { Modal } from '../base/Modal.js'
import { showToast } from '../base/toastState.js'
import { formatLog, getLogEntries, logInfo } from '../../services/log.js'
import { exportLog } from '../../services/logExport.js'

/** 原生侧日志文件的绝对路径；桌面浏览器为空 */
const nativeLogPath = (): string => {
  const bridge = (window as { __deepsleepNative?: { getLogPath?: () => string } }).__deepsleepNative
  try {
    return bridge?.getLogPath?.() ?? ''
  } catch {
    return ''
  }
}

/**
 * 运行日志面板：应用内直接看最近的时间线，也能导出成文本。
 * 只含事件摘要（条数、字节数、状态码、错误文本），不含对话正文与 Key。
 */
export const LogPanel = ({ onClose }: { onClose: () => void }) => {
  const t = useTranslate()
  const [text, setText] = useState(() => formatLog())
  const [path] = useState(() => nativeLogPath())
  const [saved, setSaved] = useState('')

  // 打开时补一条，方便对照「用户点了什么」与「后台发生了什么」
  useEffect(() => {
    logInfo('log', '打开日志面板')
    setText(formatLog())
  }, [])

  const refresh = () => {
    setText(formatLog(getLogEntries()))
    showToast({ key: 'logRefreshed' })
  }

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text)
      showToast({ key: 'logCopied' })
    } catch {
      showToast({ key: 'logCopyFailed' })
    }
  }

  const save = async () => {
    try {
      const location = await exportLog()
      setSaved(location)
      showToast({ key: 'logSaved' })
    } catch {
      showToast({ key: 'logSaveFailed' })
    }
  }

  return (
    <Modal title={t('logPanelTitle')} closable onClose={onClose}>
      <p style={{ margin: '0 0 8px', color: 'var(--text-secondary, #6b7280)', fontSize: 13 }}>
        {t('logPanelHint')}
      </p>
      {path === '' ? null : (
        <p style={{ margin: '0 0 8px', fontSize: 12, wordBreak: 'break-all' }}>
          {t('logFileLocation')}: {path}
        </p>
      )}
      {saved === '' ? null : <p style={{ margin: '0 0 8px', fontSize: 12 }}>{saved}</p>}
      <pre
        style={{
          maxHeight: '46vh',
          overflow: 'auto',
          margin: '0 0 12px',
          padding: 10,
          background: 'var(--dsw-alias-bg-l2, #f6f7f9)',
          borderRadius: 10,
          fontSize: 11,
          lineHeight: 1.5,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
        }}
      >
        {text === '' ? t('logEmpty') : text}
      </pre>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <Button variant="outlined" size="m" onClick={refresh}>
          {t('logRefresh')}
        </Button>
        <Button variant="outlined" size="m" onClick={() => void copy()}>
          {t('logCopy')}
        </Button>
        <Button variant="primary" size="m" onClick={() => void save()}>
          {t('logSave')}
        </Button>
      </div>
    </Modal>
  )
}
