import { createRoot } from 'react-dom/client'
import { App } from './app/App.js'
import { ErrorBoundary } from './app/ErrorBoundary.js'
import { setupTheme } from './app/theme.js'
import { ensureKatex } from './services/markdown/katex.js'
import { installLogHandlers, logInfo, markBootStart } from './services/log.js'
import './app/theme.css'
import './app/global.css'

// 兜底先装：后面任何一步抛错都能进日志，而不是只留一片白屏
installLogHandlers()
markBootStart()
logInfo('boot', 'frontend 启动')

ensureKatex()
setupTheme()

createRoot(document.getElementById('root') as HTMLElement).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>
)
