import { IconMenuOutline20, IconNewChatOutline20, IconSearchOutline16 } from '../base/icons.js'
import { useTranslate } from '../../i18n/index.js'
import { newChat } from '../../services/chat/store.js'
import { IconButton } from '../base/IconButton.js'
import { openMobileSider } from '../sider/mobileSiderState.js'
import { focusSiderSearch, useSiderSearch } from '../sider/siderSearchState.js'
import styles from './MobileHeader.module.css'

/** 移动端顶栏：左侧菜单打开侧边栏；会话页再显示标题与开启新对话 */
export const MobileHeader = ({ title }: { title?: string }) => {
  const t = useTranslate()
  const focusCount = useSiderSearch((state) => state.focus)
  return (
    <div className={styles.header}>
      <IconButton
        size="xl"
        tone="primary"
        icon={<IconMenuOutline20 />}
        aria-label={t('expandSiderbarButton')}
        onClick={openMobileSider}
      />
      <div className={styles.title}>{title ?? ''}</div>
      <div className={styles.actions}>
        <IconButton
          size="xl"
          tone="primary"
          icon={<IconSearchOutline16 />}
          aria-label={t('searchConversations')}
          onClick={() => {
            openMobileSider()
            void focusCount
            focusSiderSearch()
          }}
        />
        <IconButton
          size="xl"
          tone="primary"
          icon={<IconNewChatOutline20 />}
          aria-label={t('newChat')}
          onClick={newChat}
        />
      </div>
    </div>
  )
}
