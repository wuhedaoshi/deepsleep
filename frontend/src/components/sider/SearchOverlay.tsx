import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslate } from '../../i18n/index.js'
import { searchConversations, type SearchHit } from '../../services/chat/search.js'
import { selectSession } from '../../services/chat/store.js'
import { IconChevronRightOutline14, IconSearchOutline16 } from '../base/icons.js'
import styles from './SearchOverlay.module.css'

/**
 * 全屏搜索页：从右侧滑入覆盖当前界面，和官方 App 的搜索页一致。
 *
 * 输入框自动聚焦并弹出键盘；结果里标题命中排前，正文命中带上下文片段。
 * 关闭时先播完退场动画再卸载，避免闪一下消失。
 */
export const SearchOverlay = ({ open, onClose }: { open: boolean; onClose: () => void }) => {
  const t = useTranslate()
  const inputRef = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<SearchHit[]>([])
  const [mounted, setMounted] = useState(open)

  useEffect(() => {
    if (open) {
      setMounted(true)
      const timer = setTimeout(() => inputRef.current?.focus(), 180)
      return () => clearTimeout(timer)
    }
    const timer = setTimeout(() => setMounted(false), 280)
    return () => clearTimeout(timer)
  }, [open])

  useEffect(() => {
    if (!open) {
      setQuery('')
      setHits([])
      return
    }
    const keyword = query.trim()
    if (!keyword) {
      setHits([])
      return
    }
    let current = true
    setHits([])
    const timer = setTimeout(() => {
      void searchConversations(keyword).then(
        (results) => {
          if (current) {
            setHits(results)
          }
        },
        () => {
          if (current) {
            setHits([])
          }
        }
      )
    }, 180)
    return () => {
      current = false
      clearTimeout(timer)
    }
  }, [query, open])

  if (!mounted) {
    return null
  }

  // 挂到 body：抽屉本身带 transform，fixed 定位会被限制在抽屉里，只盖住半屏。
  return createPortal(
    <div className={`${styles.overlay} ${open ? styles.visible : ''}`} role="dialog">
      <div className={styles.header}>
        <button type="button" className={styles.back} aria-label={t('back')} onClick={onClose}>
          <IconChevronRightOutline14 />
        </button>
        <div className={styles.field}>
          <IconSearchOutline16 />
          <input
            ref={inputRef}
            className={styles.input}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('searchConversations')}
            aria-label={t('searchConversations')}
          />
        </div>
      </div>
      <div className={styles.results}>
        {query.trim() === '' ? null : hits.length === 0 ? (
          <div className={styles.empty}>{t('searchNoResult')}</div>
        ) : (
          hits.map((hit) => (
            <button
              key={JSON.stringify([hit.id, hit.messageId])}
              type="button"
              className={styles.hit}
              onClick={() => {
                selectSession(hit.id, hit.messageId)
                onClose()
              }}
            >
              <span className={styles.hitTitle}>{hit.title}</span>
              {hit.snippet ? <span className={styles.hitSnippet}>{hit.snippet}</span> : null}
            </button>
          ))
        )}
      </div>
    </div>,
    document.body
  )
}
