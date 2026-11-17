import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useTranslate } from '../../i18n/index.js'
import { IconCloseOutline16 } from '../base/icons.js'
import { IconButton } from '../base/IconButton.js'
import { closeMediaViewer, useMediaViewer } from './mediaViewerState.js'
import styles from './MediaViewer.module.css'

/** 打开浮层时压进历史的标记，用来区分「我们这一层」和用户自己的前进后退。 */
const HISTORY_MARK = 'deepsleep:media-viewer'

/**
 * 附件全屏预览。
 *
 * 三条退出路径都要收干净：点遮罩 / 点关闭 / 按返回键（Esc 在桌面端走同一条）。
 * 返回键靠 pushState + popstate 实现——WebView 的返回键就是浏览器的「后退」，
 * 所以只要我们在打开时压一层历史，返回时先弹掉这一层，页面本身不动。
 */
export const MediaViewer = () => {
  const t = useTranslate()
  const target = useMediaViewer((state) => state.target)
  const openRef = useRef(false)

  useEffect(() => {
    if (target === null) {
      return
    }
    openRef.current = true
    // 压一层历史：返回键先弹它，而不是离开页面
    window.history.pushState({ [HISTORY_MARK]: true }, '')
    const onPopState = () => {
      openRef.current = false
      closeMediaViewer()
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        close()
      }
    }
    /** 主动关闭：先撤掉自己那层历史，再关浮层（否则会留下一条空历史） */
    const close = () => {
      if (openRef.current && (window.history.state as Record<string, unknown> | null)?.[HISTORY_MARK]) {
        openRef.current = false
        window.history.back()
        return
      }
      openRef.current = false
      closeMediaViewer()
    }
    window.addEventListener('popstate', onPopState)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('popstate', onPopState)
      document.removeEventListener('keydown', onKeyDown)
      // 浮层被别处关掉（例如会话切换）时也要把历史层撤掉
      if (openRef.current) {
        openRef.current = false
        if ((window.history.state as Record<string, unknown> | null)?.[HISTORY_MARK]) {
          window.history.back()
        }
      }
    }
  }, [target])

  if (target === null) {
    return null
  }

  return createPortal(
    <div
      className={styles.overlay}
      role="dialog"
      aria-modal="true"
      aria-label={target.name}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          closeMediaViewer()
        }
      }}
    >
      <div className={styles.bar}>
        <div className={styles.name} title={target.name}>
          {target.name}
        </div>
        <IconButton
          className={styles.close}
          icon={<IconCloseOutline16 />}
          aria-label={t('close')}
          onClick={closeMediaViewer}
        />
      </div>
      <div
        className={styles.stage}
        onMouseDown={(event) => {
          if (event.target === event.currentTarget) {
            closeMediaViewer()
          }
        }}
      >
        {target.kind === 'image' ? (
          <img src={target.url} alt={target.name} />
        ) : (
          <iframe src={target.url} title={target.name} />
        )}
      </div>
    </div>,
    document.body
  )
}
