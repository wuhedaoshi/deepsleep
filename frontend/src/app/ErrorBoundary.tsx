import { Component, type ErrorInfo, type ReactNode } from 'react'
import { errorSummary } from '../services/log.js'
import { copyText } from '../services/clipboard.js'
import { formatLog, getLogEntries, logError } from '../services/log.js'
import { exportLog } from '../services/logExport.js'

/**
 * 兜底界面：任何渲染期异常都落到这里，而不是留一片白。
 *
 * 之前线上出现过「首次导入 + 填 Key 之后白屏」——React 18 里未捕获的渲染异常
 * 会把整棵树卸载，用户看到的就是纯白，连报错都拿不到。这里把错误摘要、
 * 最近日志和导出按钮直接摆出来，用户截图就能说明问题。
 */
type State = { error: Error | null; copied: boolean; saved: string | null }

export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  override state: State = { error: null, copied: false, saved: null }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error }
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    logError('ui', 'render crashed', {
      message: error.message,
      stack: (error.stack ?? '').slice(0, 800),
      componentStack: (info.componentStack ?? '').slice(0, 800),
    })
  }

  private copy = async () => {
    const text = `${this.state.error?.stack ?? this.state.error?.message ?? ''}\n\n${formatLog()}`
    try {
      if (!(await copyText(text))) {
        return
      }
      this.setState({ copied: true })
      setTimeout(() => this.setState({ copied: false }), 2000)
    } catch {
      // 剪贴板不可用就算了，导出按钮还在
    }
  }

  private save = async () => {
    try {
      const path = await exportLog()
      this.setState({ saved: path === '' ? '已下载' : path })
    } catch (error) {
      logError('log', '导出日志失败', errorSummary(error))
      this.setState({ saved: '导出失败' })
    }
  }

  override render() {
    const { error } = this.state
    if (error === null) {
      return this.props.children
    }
    const recent = getLogEntries().slice(-12)
    return (
      <div
        style={{
          position: 'fixed',
          inset: 0,
          overflow: 'auto',
          padding: '24px 16px',
          background: '#0d1626',
          color: '#e5e7eb',
          font: '13px/1.6 -apple-system, "Segoe UI", system-ui, sans-serif',
        }}
      >
        <div style={{ maxWidth: 720, margin: '0 auto' }}>
          <h1 style={{ fontSize: 18, margin: '0 0 8px' }}>界面出错了</h1>
          <p style={{ margin: '0 0 16px', color: '#9ca3af' }}>
            这不是崩溃退出，页面还在。可以先「重新加载」，问题复现的话点「导出日志」，把文件发给我们。
          </p>
          <pre
            style={{
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              background: '#111a2b',
              border: '1px solid #1f2937',
              borderRadius: 10,
              padding: 12,
              margin: '0 0 16px',
              fontSize: 12,
            }}
          >
            {error.name}: {error.message}
          </pre>
          <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
            <button type="button" onClick={() => location.reload()} style={buttonStyle}>
              重新加载
            </button>
            <button type="button" onClick={() => void this.save()} style={buttonStyle}>
              {this.state.saved === null ? '导出日志' : this.state.saved || '已导出'}
            </button>
            <button type="button" onClick={() => void this.copy()} style={buttonStyle}>
              {this.state.copied ? '已复制' : '复制详情'}
            </button>
          </div>
          <div style={{ color: '#9ca3af', marginBottom: 6 }}>最近的运行日志：</div>
          <pre
            style={{
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              background: '#111a2b',
              border: '1px solid #1f2937',
              borderRadius: 10,
              padding: 12,
              margin: 0,
              fontSize: 11,
            }}
          >
            {recent.length === 0 ? '(空)' : formatLog(recent)}
          </pre>
        </div>
      </div>
    )
  }
}

const buttonStyle = {
  padding: '8px 14px',
  borderRadius: 999,
  border: '1px solid #374151',
  background: '#1b2a4a',
  color: '#e5e7eb',
  fontSize: 13,
  cursor: 'pointer',
}
