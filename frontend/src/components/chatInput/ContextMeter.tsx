import { useTranslate } from '../../i18n/index.js'
import { compactWithFeedback, useChatStore } from '../../services/chat/store.js'
import { getVisibleMessages } from '../../services/chat/branches.js'
import { evaluateCompaction, resolveWindow } from '../../services/chat/compaction.js'
import { getContextRounds } from '../../services/chat/reply.js'
import { useSettings } from '../../services/settings.js'
import { Tooltip } from '../base/Tooltip.js'
import styles from './ContextMeter.module.css'

const formatTokens = (value: number): string => {
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(1)}M`
  }
  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(1)}k`
  }
  return String(value)
}

/**
 * 上下文用量：取当前分支最后一次请求的 usage 推算。
 *
 * 一次请求的上下文 = 未命中输入 + 缓存命中输入 + 缓存创建 + 本轮输出，
 * 这几个数在 message_delta 里是整轮累计值，因此最接近“现在占用多少”。
 * 没有 usage（比如刚导入的历史）时退回按字符估算，估得粗但比不显示好。
 */
export const ContextMeter = ({ sessionId }: { sessionId: string | null }) => {
  const t = useTranslate()
  const model = useSettings((state) => state.model)
  const override = useSettings((state) => state.contextWindowOverride)
  const session = useChatStore((state) =>
    sessionId === null ? undefined : state.sessionCache[sessionId]
  )
  // 压缩中禁用，避免连点重复触发（store 内部也有互斥，这里只是别让按钮看起来还能按）
  const busy = useChatStore((state) =>
    sessionId === null ? false : state.compacting[sessionId] === true
  )
  if (!session) {
    return null
  }
  const rounds = getContextRounds(getVisibleMessages(session))
  const window = resolveWindow(model, override)
  const evaluation = evaluateCompaction(rounds, session.compaction, window)
  const used = evaluation.pressure
  if (used <= 0) {
    return null
  }

  const percent = Math.min(100, (used / window) * 100)
  // 预算没超也允许点：手动压缩就是为了「不必等到撑满再整理」
  const onCompact = () => {
    if (sessionId === null || busy) {
      return
    }
    compactWithFeedback(sessionId)
  }
  return (
    <Tooltip content={t('contextUsageTooltip', {
      pressure: used.toLocaleString(),
      threshold: evaluation.threshold.toLocaleString(),
      source: evaluation.source === 'usage' ? 'usage' : t('contextSourceEstimate'),
    })}>
      <button
        type="button"
        className={styles.meter}
        aria-label={t('compactNow')}
        title={t('compactNowHint')}
        data-percent={percent.toFixed(1)}
        disabled={busy}
        onClick={onCompact}
      >
        <svg className={styles.ring} viewBox="0 0 16 16" aria-hidden="true">
          <circle className={styles.track} cx="8" cy="8" r="6" />
          <circle
            className={styles.fill}
            cx="8"
            cy="8"
            r="6"
            strokeDasharray={`${(percent / 100) * 37.7} 37.7`}
          />
        </svg>
        <span className={styles.text}>
          {formatTokens(used)} / {formatTokens(window)}
        </span>
      </button>
    </Tooltip>
  )
}
