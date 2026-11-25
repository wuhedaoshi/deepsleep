import clsx from 'clsx'
import { useEffect, useId, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useTranslate } from '../../i18n/index.js'
import { IconCloseOutline16 } from './icons.js'
import { IconButton } from './IconButton.js'
import styles from './Modal.module.css'

/** 当前打开的弹窗，后打开的在末尾；叠放时 Esc 只关闭最上层 */
const openModals: object[] = []

/** 遮罩 + 居中卡片，Esc / 点遮罩关闭 */
export const Modal = ({
  title,
  children,
  footer,
  closable = false,
  className,
  mainClassName,
  ignoreButtonLongPress = false,
  onClose,
}: {
  title: ReactNode
  children?: ReactNode
  footer?: ReactNode
  /** 标题栏右侧显示关闭按钮 */
  closable?: boolean
  className?: string
  /** 内容区的 class */
  mainClassName?: string
  ignoreButtonLongPress?: boolean
  onClose: () => void
}) => {
  const t = useTranslate()
  const titleId = useId()
  const heldButton = useRef<{ button: HTMLButtonElement; start: number } | null>(null)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  useEffect(() => {
    const token = {}
    openModals.push(token)
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && openModals.at(-1) === token) {
        onCloseRef.current()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      openModals.splice(openModals.indexOf(token), 1)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [])

  return createPortal(
    <div
      className={styles.overlay}
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <div
        className={clsx(styles.content, className)}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onPointerDownCapture={(event) => {
          if (!ignoreButtonLongPress) {
            return
          }
          const button = event.target instanceof Element ? event.target.closest('button') : null
          heldButton.current =
            event.pointerType === 'touch' && button ? { button, start: event.timeStamp } : null
        }}
        onPointerCancelCapture={() => {
          heldButton.current = null
        }}
        onContextMenu={(event) => {
          if (
            ignoreButtonLongPress &&
            event.target instanceof Element &&
            event.target.closest('button')
          ) {
            event.preventDefault()
          }
        }}
        onClickCapture={(event) => {
          const press = heldButton.current
          heldButton.current = null
          if (
            press &&
            event.detail > 0 &&
            event.target instanceof Node &&
            press.button.contains(event.target) &&
            event.timeStamp - press.start >= 500
          ) {
            event.preventDefault()
            event.stopPropagation()
          }
        }}
      >
        <div className={styles.header}>
          <div id={titleId} className={styles.title}>
            {title}
          </div>
          {closable ? (
            <IconButton
              className={styles.close}
              tone="primary"
              icon={<IconCloseOutline16 />}
              aria-label={t('close')}
              onClick={onClose}
            />
          ) : null}
        </div>
        {children ? <div className={clsx(styles.main, mainClassName)}>{children}</div> : null}
        {footer ? <div className={styles.footer}>{footer}</div> : null}
      </div>
    </div>,
    document.body
  )
}
