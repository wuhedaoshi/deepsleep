import clsx from 'clsx'
import { useEffect, useMemo, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import {
  IconSearchOutline16,
  IconPanelLeftOutline16,
  IconBatchOutline16,
  IconPinOutline16,
  IconTrashOutline16,
  IconSettingsOutline16,
} from '../base/icons.js'
import { setSiderCollapsed } from '../../services/settings.js'
import { groupSessions } from '../../services/chat/sessionGroups.js'
import { pinSessions, removeSession, useChatStore } from '../../services/chat/store.js'
import { SearchOverlay } from './SearchOverlay.js'
import type { SessionSummary } from '../../services/chat/types.js'
import { Button } from '../base/Button.js'
import { IconButton } from '../base/IconButton.js'
import { Modal } from '../base/Modal.js'
import { showToast } from '../base/toastState.js'
import { openSettings } from '../settings/settingsDialogState.js'
import { closeMobileSider, useMobileSider } from './mobileSiderState.js'
import { useSiderSearch } from './siderSearchState.js'
import { SessionItem } from './SessionItem.js'
import styles from './Sider.module.css'

/** 展开的侧边栏：名称与收起按钮、开启新对话、按时间分组的会话列表、底部设置；移动端放在抽屉里，收起按钮关闭抽屉 */
export const Sider = ({ mobile = false }: { mobile?: boolean }) => {
  const t = useTranslate()
  const sessions = useChatStore((state) => state.sessions)
  const activeId = useChatStore((state) => state.activeId)
  const [now, setNow] = useState(Date.now)
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchOrigin, setSearchOrigin] = useState<DOMRect>()
  const [searchPreparing, setSearchPreparing] = useState(false)
  const [selecting, setSelecting] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const searchFocus = useSiderSearch((state) => state.focus)

  useEffect(() => {
    if (searchFocus > 0) {
      setSearchOrigin(undefined)
      setSearchOpen(true)
    }
  }, [searchFocus])
  useEffect(() => {
    if (!searchPreparing) {
      return
    }
    let nextFrame = 0
    const frame = requestAnimationFrame(() => {
      // 先提交搜索框原位，再开始展开，避免从默认坐标起跳。
      nextFrame = requestAnimationFrame(() => {
        setSearchPreparing(false)
        setSearchOpen(true)
      })
    })
    return () => {
      cancelAnimationFrame(frame)
      cancelAnimationFrame(nextFrame)
    }
  }, [searchPreparing])
  const groups = useMemo(() => groupSessions(sessions, now, t), [sessions, now, t])


  const [deleting, setDeleting] = useState<SessionSummary | null>(null)

  const [deletePending, setDeletePending] = useState(false)

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>
    const refresh = () => {
      clearTimeout(timer)
      const time = Date.now()
      setNow(time)
      const midnight = new Date(time).setHours(24, 0, 0, 0)
      timer = setTimeout(refresh, midnight - time)
    }
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        refresh()
      }
    }
    refresh()
    document.addEventListener('visibilitychange', onVisibilityChange)
    window.addEventListener('focus', refresh)
    return () => {
      clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisibilityChange)
      window.removeEventListener('focus', refresh)
    }
  }, [])

  return (
    <div className={clsx(styles.sider, mobile && styles.mobile)}>
      {selecting ? (
        <div className={styles.batchHeader}>
          <span className={styles.batchTitle}>
            {selected.size > 0
              ? t('selectedCount', { count: selected.size })
              : t('selectConversations')}
          </span>
          <button
            type="button"
            className={styles.batchClose}
            aria-label={t('cancel')}
            onClick={() => {
              setSelecting(false)
              setSelected(new Set())
            }}
          >
            ×
          </button>
        </div>
      ) : (
      <div className={styles.top}>
        <div className={styles.appName}>{t('appName')}</div>
        <IconButton
          size="m"
          icon={<IconPanelLeftOutline16 />}
          tooltip={t('collapseSiderbarButton')}
          tooltipPlacement="bottom"
          onClick={() => (mobile ? closeMobileSider() : setSiderCollapsed(true))}
        />
      </div>
      )}
      {selecting ? null : (
      <button
        type="button"
        className={styles.searchRow}
        onClick={(event) => {
          setSearchOrigin(event.currentTarget.getBoundingClientRect())
          setSearchPreparing(true)
        }}
        aria-label={t('searchConversations')}
      >
        <IconSearchOutline16 />
        <span className={styles.searchPlaceholder}>{t('searchConversations')}</span>
      </button>
      )}
      <div className={styles.listWrap}>
        <div className={styles.list}>
          {groups.map((group, groupIndex) => (
            <div key={group.key} className={styles.section}>
              <div className={styles.sectionHeader}>
                <span>{group.label}</span>
                {groupIndex === 0 && !selecting ? (
                  <button
                    type="button"
                    className={styles.batchButton}
                    aria-label={t('batchManage')}
                    onClick={() => {
                      setSelecting(true)
                      setSelected(new Set())
                    }}
                  >
                    <IconBatchOutline16 />
                  </button>
                ) : null}
              </div>
              {group.sessions.map((session) => (
                <SessionItem
                  key={session.id}
                  session={session}
                  active={session.id === activeId}
                  selecting={selecting}
                  selected={selected.has(session.id)}
                  onToggle={() => {
                    setSelected((current) => {
                      const next = new Set(current)
                      if (next.has(session.id)) {
                        next.delete(session.id)
                      } else {
                        next.add(session.id)
                      }
                      return next
                    })
                  }}
                  onDelete={() => setDeleting(session)}
                />
              ))}
            </div>
          ))}
        </div>
      </div>
      {selecting ? (
        <div className={styles.selectBar}>
          <button
            type="button"
            className={styles.selectBarPin}
            disabled={selected.size === 0}
            onClick={() => {
              const ids = [...selected]
              const allPinned = ids.every(
                (id) => sessions.find((session) => session.id === id)?.pinned
              )
              pinSessions(ids, !allPinned)
              setSelected(new Set())
              setSelecting(false)
            }}
          >
            <IconPinOutline16 />
            <span>
              {[...selected].every((id) => sessions.find((session) => session.id === id)?.pinned)
                ? t('unpinFromTop')
                : t('pinToTop')}
            </span>
          </button>
          <span className={styles.selectBarDivider} />
          <button
            type="button"
            className={styles.selectBarDelete}
            disabled={selected.size === 0}
            onClick={() => {
              void Promise.all([...selected].map((id) => removeSession(id)))
              setSelected(new Set())
              setSelecting(false)
            }}
          >
            <IconTrashOutline16 />
            <span>{t('delete')}</span>
          </button>
        </div>
      ) : (
      <div className={styles.bottom}>
        <button type="button" className={styles.settings} onClick={() => openSettings('general')}>
          <span className={styles.settingsIcon}>
            <IconSettingsOutline16 />
          </span>
          <span className={styles.settingsLabel}>{t('settings')}</span>
        </button>
      </div>
      )}
      <SearchOverlay
        open={searchOpen}
        origin={searchOrigin}
        preparing={searchPreparing}
        onClose={(selected) => {
          setSearchOpen(false)
          if (mobile && selected) {
            closeMobileSider()
          }
        }}
      />
      {deleting ? (
        <Modal
          title={t('deleteSessionModalContentTitle')}
          onClose={() => {
            if (!deletePending) {
              setDeleting(null)
            }
          }}
          footer={
            <>
              <Button variant="outlined" disabled={deletePending} onClick={() => setDeleting(null)}>
                {t('cancel')}
              </Button>
              <Button
                variant="danger"
                disabled={deletePending}
                onClick={async () => {
                  setDeletePending(true)
                  try {
                    if (await removeSession(deleting.id)) {
                      setDeleting(null)
                    } else {
                      showToast({ key: 'sessionDeleteFailed', type: 'error' })
                    }
                  } finally {
                    setDeletePending(false)
                  }
                }}
              >
                {t('delete')}
              </Button>
            </>
          }
        >
          {t('deleteSessionWithFilesDescription')}
        </Modal>
      ) : null}
    </div>
  )
}

/** 移动端抽屉：浮在页面上方，点空白区域关闭。 */
export const MobileSider = () => {
  const open = useMobileSider((state) => state.open)
  // 常驻挂载，靠 data-open 驱动位移与淡入淡出，收起时保留退场动画。
  return (
    <div className={styles.drawerLayer} data-open={open || undefined}>
      <div className={styles.drawerMask} onClick={closeMobileSider} aria-hidden="true" />
      <div className={styles.drawer} role="dialog" aria-hidden={!open} data-ds-drawer>
        <div className={styles.drawerBackdrop} />
        <div className={styles.drawerBody}>
          <Sider mobile />
        </div>
      </div>
    </div>
  )
}
