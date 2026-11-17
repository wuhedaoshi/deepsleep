import clsx from 'clsx'
import { useTranslate } from '../../i18n/index.js'
import { compactNow, useChatStore } from '../../services/chat/store.js'
import { getVisibleMessages } from '../../services/chat/branches.js'
import { getContextRounds } from '../../services/chat/reply.js'
import { showToast } from '../base/toastState.js'
import { Tooltip } from '../base/Tooltip.js'
import styles from './ContextMeter.module.css'

/** deepseek-flash 的上下文窗口（tokens），与官方价格页的 1M 对应。 */
const CONTEXT_WINDOW = 1_000_000

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
  const session = useChatStore((state) =>
    sessionId === null ? undefined : state.sessionCache[sessionId]
  )
  const compacting = useChatStore((state) =>
    sessionId !== null && state.compacting[sessionId] === true
  )
  if (!session) {
    return null
  }
  const path = getVisibleMessages(session)
  const lastReply = [...path]
    .reverse()
    .find((message) => message.role === 'assistant' && message.usage !== undefined)
  const lastUsage = lastReply?.role === 'assistant' ? lastReply.usage : undefined

  let used = 0
  if (lastUsage) {
    used =
      lastUsage.input_tokens +
      lastUsage.cache_read_input_tokens +
      lastUsage.cache_creation_input_tokens +
      lastUsage.output_tokens
  } else {
    const characters = path.reduce((sum, message) => {
      if (message.role === 'user') {
        return sum + message.content.length
      }
      return (
        sum +
        message.blocks.reduce((acc, block) => {
          if (block.type === 'text') {
            return acc + block.text.length
          }
          if (block.type === 'thinking') {
            return acc + block.thinking.length
          }
          return acc
        }, 0)
      )
    }, 0)
    // 中文约 1 token/字，混合文本按 0.75 折算，只用于量级提示。
    used = Math.round(characters * 0.75)
  }
  if (used <= 0) {
    return null
  }

  if (compacting) {
    return (
      <span className={styles.meter} aria-label={t('contextCompacting')}>
        <span className={styles.text}>{t('contextCompacting')}</span>
      </span>
    )
  }

  const compacted = session.compaction !== undefined
  const percent = Math.min(100, (used / CONTEXT_WINDOW) * 100)
  // 手动压缩的入口就是这个环本身：它原本就在这一行里，尺寸不变，
  // 竖屏窄版上不会把「深度思考 / 智能搜索」挤变形（多一个按钮就会）。
  const rounds = getContextRounds(path).length
  const canCompact = sessionId !== null && rounds >= 2
  const hint = compacted ? t('contextUsageCompacted') : t('contextUsageTooltip')
  const body = (
    <>
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
        {formatTokens(used)} / {formatTokens(CONTEXT_WINDOW)}
      </span>
    </>
  )
  if (!canCompact) {
    return (
      <Tooltip content={hint}>
        <span
          className={styles.meter}
          aria-label={t('contextUsage')}
          data-percent={percent.toFixed(1)}
        >
          {body}
        </span>
      </Tooltip>
    )
  }
  return (
    <Tooltip content={`${hint}\n${t('compactNowHint')}`}>
      <button
        type="button"
        className={clsx(styles.meter, styles.pressable)}
        aria-label={t('compactNow')}
        data-percent={percent.toFixed(1)}
        onClick={() => {
          void compactNow(sessionId).then((outcome) => {
            showToast({
              key:
                outcome === 'done'
                  ? 'compactDone'
                  : outcome === 'nothing'
                    ? 'compactNothing'
                    : 'compactFailed',
            })
          })
        }}
      >
        {body}
      </button>
    </Tooltip>
  )
}
