import { useRef } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { ACCEPT } from '../../services/attachments.js'
import { IconCameraOutline20, IconFileOutline20, IconImageOutline20 } from '../base/icons.js'
import styles from './AttachSheet.module.css'

/**
 * 移动端的附件入口：底部抽屉里给三个大按钮（拍照 / 相册 / 文件），
 * 和官方 App 一致。桌面端仍然直接弹文件选择器。
 *
 * 三个隐藏 input 各管一路：拍照要 capture 属性才能唤起相机，相册限图片，
 * 文件走完整的 ACCEPT 列表。
 */
export const AttachSheet = ({
  open,
  onClose,
  onFiles,
}: {
  open: boolean
  onClose: () => void
  onFiles: (files: File[]) => void
}) => {
  const t = useTranslate()
  const cameraRef = useRef<HTMLInputElement>(null)
  const albumRef = useRef<HTMLInputElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const take = (target: React.RefObject<HTMLInputElement | null>) => {
    onClose()
    // 等抽屉收起动画起步再唤起选择器，避免在部分 ROM 上被动画打断。
    setTimeout(() => target.current?.click(), 120)
  }

  /** 相机优先走原生 Intent：WebView 的 capture 在多数国产 ROM 上唤不起相机。 */
  const takePhoto = () => {
    const bridge = (window as unknown as {
      __deepsleepNative?: { takePhoto?: () => void }
    }).__deepsleepNative
    if (bridge?.takePhoto) {
      onClose()
      bridge.takePhoto()
      return
    }
    take(cameraRef)
  }

  const handle = (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? [])
    event.target.value = ''
    if (files.length > 0) {
      onFiles(files)
    }
  }

  return (
    <>
      <div
        className={`${styles.mask} ${open ? styles.maskOpen : ''}`}
        onClick={onClose}
        aria-hidden={!open}
      />
      <div className={`${styles.sheet} ${open ? styles.sheetOpen : ''}`} role="dialog">
        <div className={styles.grabber} />
        <div className={styles.tiles}>
          <button type="button" className={styles.tile} onClick={takePhoto}>
            <IconCameraOutline20 />
            <span>{t('attachCamera')}</span>
          </button>
          <button type="button" className={styles.tile} onClick={() => take(albumRef)}>
            <IconImageOutline20 />
            <span>{t('attachAlbum')}</span>
          </button>
          <button type="button" className={styles.tile} onClick={() => take(fileRef)}>
            <IconFileOutline20 />
            <span>{t('attachFile')}</span>
          </button>
        </div>
        <button type="button" className={styles.cancel} onClick={onClose}>
          {t('cancel')}
        </button>
        <input
          ref={cameraRef}
          type="file"
          accept="image/*"
          capture="environment"
          hidden
          onChange={handle}
        />
        <input ref={albumRef} type="file" accept="image/*" multiple hidden onChange={handle} />
        <input ref={fileRef} type="file" accept={ACCEPT} multiple hidden onChange={handle} />
      </div>
    </>
  )
}
