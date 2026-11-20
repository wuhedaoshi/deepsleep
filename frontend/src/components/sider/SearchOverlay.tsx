import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { useTranslate } from '../../i18n/index.js'
import { searchConversations, type SearchHit } from '../../services/chat/search.js'
import { selectSession } from '../../services/chat/store.js'
import { IconChevronRightOutline14, IconSearchOutline16 } from '../base/icons.js'
import styles from './SearchOverlay.module.css'

/** 搜索面板从触发框展开，展开后再唤起键盘。 */
export const SearchOverlay = ({
  open,
  origin,
  preparing,
  onClose,
}: {
  open: boolean
  origin?: DOMRect
  preparing: boolean
  onClose: (selected?: boolean) => void
}) => {
  const originStyle = origin
    ? ({
        '--search-x': `${origin.left}px`,
        '--search-y': `${origin.top}px`,
        '--search-end-x': `${origin.right}px`,
        '--search-height': `${origin.height}px`,
      } as CSSProperties)
    : undefined
  const t = useTranslate()
  const inputRef = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<SearchHit[]>([])
  const pendingFocus = useRef(false)
  const focusSearch = () => {
    if (pendingFocus.current) {
      pendingFocus.current = false
      inputRef.current?.focus({ preventScroll: true })
    }
  }

  useEffect(() => {
    if (!open) {
      pendingFocus.current = false
      inputRef.current?.blur()
      return
    }
    pendingFocus.current = true
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    // transitionend 是主路径；动效关闭或事件未送达时仍可自动聚焦。
    const fallback = setTimeout(focusSearch, reducedMotion ? 0 : 340)
    return () => {
      pendingFocus.current = false
      clearTimeout(fallback)
    }
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

  // 挂到 body：抽屉本身带 transform，fixed 定位会被限制在抽屉里，只盖住半屏。
  return createPortal(
    <div
      className={`${styles.overlay} ${open ? styles.visible : ''} ${preparing ? styles.preparing : ''}`}
      style={originStyle}
      role="dialog"
      aria-hidden={!open}
      onTransitionEnd={(event) => {
        if (open && event.target === event.currentTarget && event.propertyName === 'clip-path') {
          focusSearch()
        }
      }}
    >
      <div className={styles.header}>
        <button
          type="button"
          className={styles.back}
          tabIndex={open ? 0 : -1}
          aria-label={t('back')}
          onClick={() => onClose()}
        >
          <IconChevronRightOutline14 />
        </button>
        <div className={styles.field}>
          <IconSearchOutline16 />
          <input
            ref={inputRef}
            className={styles.input}
            tabIndex={open ? 0 : -1}
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
              tabIndex={open ? 0 : -1}
              onClick={() => {
                selectSession(hit.id, hit.messageId)
                onClose(true)
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
