import { useTranslate } from '../../i18n/index.js'
import { compactWithFeedback, useChatStore } from '../../services/chat/store.js'
import { getVisibleMessages } from '../../services/chat/branches.js'
import {
  DEFAULT_MODEL,
  evaluateRequestContext,
  outputCapFor,
  policyFor,
  readContextOverflow,
  resolveWindow,
} from '../../services/chat/compaction.js'
import { getContextRounds } from '../../services/chat/reply.js'
import { useDrafts } from '../../services/chat/drafts.js'
import { createLatestReminder } from '../../services/chat/latestReminder.js'
import { useSettings } from '../../services/settings.js'
import { Tooltip } from '../base/Tooltip.js'
import styles from './ContextMeter.module.css'

const formatTokens = (value: number): string => {
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(2)}M`
  }
  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(1)}k`
  }
  return String(value)
}

/** 接近发送口径的输入估算，或展示最近一次被拒请求的服务端用量。 */
export const ContextMeter = ({ sessionId }: { sessionId: string | null }) => {
  const t = useTranslate()
  const settings = useSettings()
  const { contextWindowOverride, thinking, search } = settings
  const model = DEFAULT_MODEL
  const draft = useDrafts((state) => state.drafts.get(sessionId)?.text ?? '')
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
  const visible = getVisibleMessages(session)
  const tail = visible.at(-1)
  const tailQuestion = visible.at(-2)
  const activeQuestion =
    !draft &&
    tail?.role === 'assistant' &&
    (tail.status === 'pending' || tail.status === 'streaming') &&
    tailQuestion?.role === 'user'
      ? tailQuestion.content
      : ''
  const observed =
    !draft && tail?.role === 'assistant' && tail.status === 'error' && tail.model === model
      ? readContextOverflow(tail.error?.message)
      : undefined
  const window = observed?.window ?? resolveWindow(model, contextWindowOverride)
  const policy = policyFor(window, observed?.output ?? outputCapFor(window))
  const evaluation = evaluateRequestContext(
    getContextRounds(visible),
    session.compaction,
    policy,
    {
      model,
      thinking,
      search,
      system: '该助手为DeepSeek，由深度求索公司创造。',
    },
    draft || activeQuestion,
    createLatestReminder(settings)
  )
  const used = observed ? observed.input + observed.output : evaluation.pressure
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
    <Tooltip
      content={
        observed
          ? t('contextServerUsage', {
              input: observed.input.toLocaleString(),
              output: observed.output.toLocaleString(),
              window: observed.window.toLocaleString(),
            })
          : t('contextUsageTooltip', {
              pressure: used.toLocaleString(),
              threshold: evaluation.threshold.toLocaleString(),
              source: t(
                evaluation.source === 'usage' ? 'contextSourceProjected' : 'contextSourceEstimate'
              ),
            })
      }
    >
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
