import { createRoot } from 'react-dom/client'
import { App } from './app/App.js'
import { ErrorBoundary } from './app/ErrorBoundary.js'
import { RecoveryScreen, shouldShowRecovery } from './app/RecoveryScreen.js'
import { setupTheme } from './app/theme.js'
import { ensureKatex } from './services/markdown/katex.js'
import { installLogHandlers, logInfo, markBootStart } from './services/log.js'
import './app/theme.css'
import './app/global.css'

// 兜底先装：后面任何一步抛错都能进日志，而不是只留一片白屏
installLogHandlers()
markBootStart()

const root = createRoot(document.getElementById('root') as HTMLElement)

// 连续两次启动没走完：先给恢复界面（它不加载历史），让用户能导日志或清数据，
// 而不是继续在同一个地方再白一次。
if (shouldShowRecovery()) {
  root.render(<RecoveryScreen />)
} else {
  logInfo('boot', 'frontend 启动')
  ensureKatex()
  setupTheme()
  root.render(
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  )
}
// 通知 index.html 里的内联兜底：前端确实起来了，别弹「界面没加载出来」
;(window as unknown as { __deepsleepBootOk?: () => void }).__deepsleepBootOk?.()