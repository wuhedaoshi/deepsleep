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
 * 面板保持挂载，滑入完成后再聚焦，避免动画中途被键盘触发重新布局。
 */
export const SearchOverlay = ({ open, onClose }: { open: boolean; onClose: () => void }) => {
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
    const fallback = setTimeout(focusSearch, reducedMotion ? 0 : 300)
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
      className={`${styles.overlay} ${open ? styles.visible : ''}`}
      role="dialog"
      aria-hidden={!open}
      onTransitionEnd={(event) => {
        if (open && event.target === event.currentTarget && event.propertyName === 'transform') {
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
          onClick={onClose}
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
