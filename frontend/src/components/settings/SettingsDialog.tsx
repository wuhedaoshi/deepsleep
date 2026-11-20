import clsx from 'clsx'
import { ProviderSettings } from './ProviderSettings.js'
import { createId } from '../../utils/id.js'
import type { ThinkingEffort } from '../../services/api/types.js'
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import {
  IconDarkOutline16,
  IconDataOutline16,
  IconDownloadOutline16,
  IconFollowsystemOutline16,
  IconLightOutline16,
  IconSettingsOutline16,
  IconUploadOutline14,
} from '../base/icons.js'
import {
  ATTACHMENT_SIZE_LIMIT_MB,
  BackupError,
  clearHistory,
  exportHistory,
  importHistory,
  type ImportProgress,
} from '../../services/chat/backup.js'
import { useIsMobile } from '../../app/viewport.js'
import { useChatStore } from '../../services/chat/store.js'
import { fetchBalance, formatBalance } from '../../services/api/balance.js'
import { regionCodes, getRegionName, provinces } from '../../services/location.js'
import {
  isChineseBrowser,
  setLocale,
  setLocation,
  setThemePreference,
  setEnterKey,
  parseContextWindowInput,
  setContextWindowOverride,
  setModel,
  setApiMode,
  setThinking,
  setThinkingEffort,
  setSafetyLevel,
  setPromptPreferences,
  setTtsVoice,
  useSettings,
  type ThemePreference,
} from '../../services/settings.js'
import { useTranslate, type TranslationKey, type TranslationMessage } from '../../i18n/index.js'
import { Button } from '../base/Button.js'
import { Modal } from '../base/Modal.js'
import { Select } from '../base/Select.js'
import { showToast } from '../base/toastState.js'
import { ApiKeyConfirm, ApiKeyField, useApiKeyEditor } from './ApiKeyField.js'
import { LogPanel } from './LogPanel.js'
import { closeSettings, useSettingsDialog, type SettingsSection } from './settingsDialogState.js'
import styles from './Settings.module.css'
import { COMPACTION_POLICY, resolveWindow } from '../../services/chat/compaction.js'

/**
 * 设置弹窗：分「通用设置」（主题、语言、朗读音色、位置）与「数据管理」（API Key、导入、导出、删除）。
 * 桌面端为居中弹窗、左侧导航；移动端为底部弹层、导航横排在内容上方
 */
export const SettingsDialog = () => {
  const open = useSettingsDialog((state) => state.open)
  return open ? <SettingsContent /> : null
}

const sections: { value: SettingsSection; label: TranslationKey; icon: ReactNode }[] = [
  {
    value: 'general',
    label: 'settingDialogAsideGeneralOptionLabel',
    icon: <IconSettingsOutline16 />,
  },
  { value: 'data', label: 'settingDialogAsideDataOptionLabel', icon: <IconDataOutline16 /> },
  { value: 'experimental', label: 'settingsExperimental', icon: <IconSettingsOutline16 /> },
]

const SettingsContent = () => {
  const t = useTranslate()
  const isMobile = useIsMobile()
  // 打开时按调用方指定的分组选中，之后在弹窗内切换
  const [section, setSection] = useState(() => useSettingsDialog.getState().section)
  // 切换分组不丢失正在输入的 API Key 与导入状态
  const apiKeyEditor = useApiKeyEditor()
  const historyImport = useHistoryImport()
  const historyDelete = useHistoryDelete()
  const [logOpen, setLogOpen] = useState(false)
  const replacingHistory = useChatStore((state) => state.importingHistory)
  const historyBusy = historyImport.busy || historyDelete.busy || replacingHistory
  return (
    <>
      <Modal
        title={t('settings')}
        closable
        className={styles.dialog}
        mainClassName={styles.dialogMain}
        onClose={() => {
          if (!historyDelete.busy) {
            closeSettings()
          }
        }}
      >
        <div role="tablist" className={styles.navigation}>
          {sections.map((item) => (
            <button
              key={item.value}
              type="button"
              role="tab"
              aria-selected={section === item.value}
              className={clsx(styles.navItem, section === item.value && styles.navItemActive)}
              onClick={() => setSection(item.value)}
            >
              {item.icon}
              {t(item.label)}
            </button>
          ))}
        </div>
        <div role="tabpanel" className={styles.content}>
          {section === 'general' ? (
            <>
              <ThemeSetting />
              <LocaleSetting />
              <EnterKeySetting />
              <TtsVoiceSetting />
              <LocationSetting />
            </>
          ) : section === 'experimental' ? (
            <ExperimentalSettings />
          ) : (
            <>
              <ApiKeyField editor={apiKeyEditor} />
              <BalanceSetting />
              <ImportHistory historyImport={historyImport} disabled={historyBusy} />
              {historyImport.progress ? (
                <ImportProgressBar progress={historyImport.progress} />
              ) : null}
              <ExportHistory disabled={historyBusy} />
              <SettingCell
                label={t('deleteAllSessions')}
                status={null}
                action={
                  <Button
                    variant="dangerOutlined"
                    size="m"
                    className={styles.cellButton}
                    disabled={historyBusy}
                    onClick={historyDelete.open}
                  >
                    {t('delete')}
                  </Button>
                }
              />{' '}
              <SettingCell
                label={t('runLog')}
                status={{ key: 'runLogHint' }}
                action={
                  <Button
                    variant="outlined"
                    size="m"
                    className={styles.cellButton}
                    onClick={() => setLogOpen(true)}
                  >
                    {t('runLogView')}
                  </Button>
                }
              />
              {isMobile ? <ApiKeyConfirm editor={apiKeyEditor} /> : null}
            </>
          )}
        </div>
        {/* 版本行：安装后能直接确认是不是新包——之前没有这行，只能去系统设置里翻，很容易看成「版本没变」 */}
        <div className={styles.version}>{appVersionLine()}</div>
      </Modal>
      {historyImport.file ? <ImportConfirm historyImport={historyImport} /> : null}
      {logOpen ? <LogPanel onClose={() => setLogOpen(false)} /> : null}
      {historyDelete.opened ? <DeleteAllConfirm historyDelete={historyDelete} /> : null}
    </>
  )
}

/** 删除确认保留在设置之上；失败可重试，成功只关闭确认弹窗。 */
const DeleteAllConfirm = ({
  historyDelete,
}: {
  historyDelete: ReturnType<typeof useHistoryDelete>
}) => {
  const t = useTranslate()
  return (
    <Modal
      title={t('deleteAllSessionsModalTitle')}
      className={styles.deleteConfirm}
      onClose={historyDelete.cancel}
      footer={
        <div className={styles.deleteActions} aria-busy={historyDelete.busy}>
          <Button
            variant="outlined"
            autoFocus
            disabled={historyDelete.busy}
            onClick={historyDelete.cancel}
          >
            {t('cancel')}
          </Button>
          <Button
            variant="danger"
            disabled={historyDelete.busy}
            onClick={() => void historyDelete.confirm()}
          >
            {t(historyDelete.busy ? 'historyDeleting' : 'deleteAllSessions')}
          </Button>
        </div>
      }
    >
      {t('deleteAllSessionsModalDescription')}
    </Modal>
  )
}

const useHistoryDelete = () => {
  const [opened, setOpened] = useState(false)
  const [busy, setBusy] = useState(false)
  const deleting = useRef(false)

  const confirm = async () => {
    if (deleting.current) {
      return
    }
    deleting.current = true
    setBusy(true)
    try {
      await clearHistory()
      setOpened(false)
      showToast({ key: 'historyDeleted' })
    } catch {
      showToast({ key: 'historyDeleteFailed', type: 'error' })
    } finally {
      deleting.current = false
      setBusy(false)
    }
  }

  return {
    opened,
    busy,
    open: () => setOpened(true),
    cancel: () => {
      if (!deleting.current) {
        setOpened(false)
      }
    },
    confirm,
  }
}

const ExperimentalSettings = () => {
  const t = useTranslate()
  const apiMode = useSettings((state) => state.apiMode)
  const customChat = useSettings((state) => apiMode === 'standard' && Boolean(state.connections.chat))
  const model = useSettings((state) => state.model)
  const thinking = useSettings((state) => state.thinking)
  const effort = useSettings((state) => state.thinkingEffort)
  const safety = useSettings((state) => state.safetyLevel)
  return (
    <>
      <SettingCell
        label={t('settingsApiMode')}
        description={t('settingsApiModeHint')}
        status={null}
        action={
          <Select
            value={apiMode}
            ariaLabel={t('settingsApiMode')}
            onChange={setApiMode}
            options={[
              { value: 'extended', label: t('settingsApiExtended') },
              { value: 'standard', label: t('settingsApiStandard') },
            ]}
          />
        }
      />
      {apiMode === 'standard' && <ProviderSettings />}
      {!customChat && <SettingCell
        label={t('settingsModel')}
        description={t('settingsModelHint')}
        status={null}
        action={
          <Select
            value={model}
            ariaLabel={t('settingsModel')}
            onChange={setModel}
            options={[
              { value: 'deepseek-flash', label: 'DeepSeek Flash' },
              { value: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro' },
            ]}
          />
        }
      />
      }
      {!customChat && <SettingCell
        label={t('settingsThinkingEffort')}
        status={null}
        action={
          <Select<ThinkingEffort | 'off'>
            value={thinking ? effort : 'off'}
            ariaLabel={t('settingsThinkingEffort')}
            onChange={(value) => {
              if (value !== 'off') {
                setThinkingEffort(value)
              }
              setThinking(value !== 'off')
            }}
            options={[
              { value: 'off', label: t('settingsThinkingOff') },
              { value: 'low', label: t('settingsThinkingLow') },
              { value: 'high', label: t('settingsThinkingHigh') },
              { value: 'max', label: t('settingsThinkingMax') },
            ]}
          />
        }
      />
      }
      <ContextWindowSetting />
      <SettingCell
        label={t('settingsSafetyLevel')}
        status={null}
        action={
          <Select
            value={safety}
            disabled={apiMode === 'standard'}
            ariaLabel={t('settingsSafetyLevel')}
            onChange={setSafetyLevel}
            options={[
              { value: 'low', label: t('settingsSafetyStandard') },
              { value: 'high', label: t('settingsSafetyHigh') },
            ]}
          />
        }
      />
      <PromptPresetSetting />
    </>
  )
}

const WINDOW_CHOICES = ['300000', '600000', '1000000', '1400000']

const ContextWindowSetting = () => {
  const t = useTranslate()
  const model = useSettings((state) => state.model)
  const override = useSettings((state) => state.contextWindowOverride)
  const [choice, setChoice] = useState(() => {
    if (override === null) {
      return 'auto'
    }
    return WINDOW_CHOICES.includes(String(override)) ? String(override) : 'custom'
  })
  const [value, setValue] = useState(override === null ? '' : String(override))
  const minimum = COMPACTION_POLICY.outputReserve + COMPACTION_POLICY.headroom
  const external = useSettings((state) => state.apiMode === 'standard' && Boolean(state.connections.chat))
  const window = resolveWindow(model, null, external)
  const parsed = parseContextWindowInput(value)
  const invalid =
    choice === 'custom' && value.trim() !== '' && (parsed === null || parsed <= minimum)
  return (
    <SettingCell
      label={t('settingsContextWindow')}
      description={t(external ? 'providerWindowHint' : 'settingsContextWindowHint', { window, minimum })}
      status={invalid ? { key: 'settingsContextWindowInvalid', params: { minimum } } : null}
      className={styles.contextWindowCell}
      action={
        <div className={styles.experimentalControls}>
          <Select
            value={choice}
            ariaLabel={t('settingsContextWindow')}
            options={[
              { value: 'auto', label: t('settingsWindowAuto') },
              ...WINDOW_CHOICES.map((tokens) => ({
                value: tokens,
                label: Number(tokens).toLocaleString(),
              })),
              { value: 'custom', label: t('settingsWindowCustom') },
            ]}
            onChange={(next) => {
              setChoice(next)
              if (next !== 'custom') {
                setContextWindowOverride(next === 'auto' ? null : Number(next))
                setValue(next === 'auto' ? '' : next)
              }
            }}
          />
          {choice === 'custom' ? (
            <input
              className={styles.contextWindowInput}
              type="text"
              aria-label={t('settingsWindowCustom')}
              aria-invalid={invalid}
              placeholder={String(window)}
              value={value}
              onChange={(event) => {
                const next = event.currentTarget.value
                setValue(next)
                const number = parseContextWindowInput(next)
                if (next.trim() === '') {
                  setContextWindowOverride(null)
                } else if (number !== null && number > minimum) {
                  setContextWindowOverride(number)
                }
              }}
            />
          ) : null}
        </div>
      }
    />
  )
}

const PromptPresetSetting = () => {
  const t = useTranslate()
  const presets = useSettings((state) => state.promptPresets)
  const activeId = useSettings((state) => state.activePromptId)
  const [draft, setDraft] = useState(() => presets.find((preset) => preset.id === activeId))
  const canSave = Boolean(draft?.name.trim() && draft.text.trim())
  return (
    <SettingCell
      label={t('settingsPromptPreset')}
      description={t('settingsPromptHint')}
      status={null}
      className={styles.contextWindowCell}
      action={
        <div className={styles.experimentalControls}>
          <div className={styles.experimentalActions}>
            <Select
              value={activeId ?? ''}
              ariaLabel={t('settingsPromptPreset')}
              options={[
                { value: '', label: t('settingsPromptDefault') },
                ...presets.map(({ id, name }) => ({ value: id, label: name })),
              ]}
              onChange={(id) => {
                setPromptPreferences(presets, id || null)
                setDraft(presets.find((preset) => preset.id === id))
              }}
            />
            <Button
              variant="outlined"
              size="m"
              onClick={() => setDraft({ id: createId(), name: '', text: '' })}
            >
              {t('settingsPromptNew')}
            </Button>
          </div>
          {draft ? (
            <>
              <input
                className={styles.contextWindowInput}
                aria-label={t('settingsPromptName')}
                placeholder={t('settingsPromptName')}
                maxLength={80}
                value={draft.name}
                onChange={(event) => setDraft({ ...draft, name: event.currentTarget.value })}
              />
              <textarea
                className={styles.contextWindowInput}
                rows={5}
                aria-label={t('settingsPromptText')}
                placeholder={t('settingsPromptText')}
                value={draft.text}
                onChange={(event) => setDraft({ ...draft, text: event.currentTarget.value })}
              />
              <div className={styles.experimentalActions}>
                <Button
                  variant="outlined"
                  size="m"
                  disabled={!canSave}
                  onClick={() => {
                    const saved = { ...draft, name: draft.name.trim(), text: draft.text.trim() }
                    const next = presets.some((preset) => preset.id === saved.id)
                      ? presets.map((preset) => (preset.id === saved.id ? saved : preset))
                      : [...presets, saved]
                    setPromptPreferences(next, saved.id)
                    setDraft(saved)
                  }}
                >
                  {t('settingsPromptSave')}
                </Button>
                {presets.some((preset) => preset.id === draft.id) ? (
                  <Button
                    variant="dangerOutlined"
                    size="m"
                    onClick={() => {
                      setPromptPreferences(
                        presets.filter((preset) => preset.id !== draft.id),
                        null
                      )
                      setDraft(undefined)
                    }}
                  >
                    {t('delete')}
                  </Button>
                ) : null}
              </div>
            </>
          ) : null}
        </div>
      }
    />
  )
}

const LocationSetting = () => {
  const t = useTranslate()
  const locale = useSettings((state) => state.locale)
  const location = useSettings((state) => state.location)
  const province =
    location?.region === 'CN'
      ? provinces.find((item) => item.code === location.province)
      : undefined

  return (
    <SettingCell
      label={t('settingsLocation')}
      status={null}
      className={styles.locationCell}
      action={
        <div className={styles.locationSelectors}>
          {isChineseBrowser() ? (
            <>
              <Select
                ariaLabel={t('settingsLocationProvince')}
                className={styles.provinceSelect}
                value={province?.code ?? ''}
                placeholder={t('settingsLocationProvince')}
                options={provinces.map((item) => ({ value: item.code, label: item.name }))}
                onChange={(value) => {
                  if (value !== province?.code) {
                    setLocation({ region: 'CN', province: value })
                  }
                }}
              />
              <Select
                ariaLabel={t('settingsLocationCity')}
                className={styles.citySelect}
                value={province ? (location?.city ?? '') : ''}
                disabled={!province?.cities.length}
                placeholder={t('settingsLocationCity')}
                options={
                  province?.cities.map((item) => ({ value: item.code, label: item.name })) ?? []
                }
                onChange={(value) => {
                  if (province) {
                    setLocation({ region: 'CN', province: province.code, city: value })
                  }
                }}
              />
            </>
          ) : (
            <Select
              ariaLabel={t('settingsLocationRegion')}
              className={styles.regionSelect}
              value={location?.region ?? ''}
              placeholder={t('settingsLocationRegion')}
              options={regionCodes
                .map((code) => ({ value: code, label: getRegionName(code, locale) }))
                .sort((a, b) => a.label.localeCompare(b.label, locale))}
              onChange={(value) => setLocation({ region: value })}
            />
          )}
        </div>
      }
    />
  )
}

const LocaleSetting = () => {
  const t = useTranslate()
  const locale = useSettings((state) => state.locale)
  return (
    <SettingCell
      label={t('settingsLocalePreference')}
      status={null}
      action={
        <Select
          ariaLabel={t('settingsLocalePreference')}
          value={locale}
          options={[
            { value: 'zh-CN', label: t('settingsLocaleZhCN'), lang: 'zh-CN' },
            { value: 'en-US', label: t('settingsLocaleEnUS'), lang: 'en' },
          ]}
          onChange={setLocale}
        />
      }
    />
  )
}

/** 回车键：发送，或换行（换行时 Ctrl/⌘+Enter 发送） */
const EnterKeySetting = () => {
  const t = useTranslate()
  const enterKey = useSettings((state) => state.enterKey)
  return (
    <SettingCell
      label={t('settingsEnterKey')}
      status={{ key: 'settingsEnterKeyHint' }}
      action={
        <Select
          ariaLabel={t('settingsEnterKey')}
          value={enterKey}
          options={[
            { value: 'send', label: t('settingsEnterKeySend') },
            { value: 'newline', label: t('settingsEnterKeyNewline') },
          ]}
          onChange={setEnterKey}
        />
      }
    />
  )
}

/** 朗读音色：stella（海星，女声）/ tide（暗潮，男声） */
const TtsVoiceSetting = () => {
  const t = useTranslate()
  const ttsVoice = useSettings((state) => state.ttsVoice)
  return (
    <SettingCell
      label={t('settingsTtsVoice')}
      status={null}
      action={
        <Select
          ariaLabel={t('settingsTtsVoice')}
          value={ttsVoice}
          options={[
            { value: 'stella', label: t('settingsTtsVoiceStella') },
            { value: 'tide', label: t('settingsTtsVoiceTide') },
          ]}
          onChange={setTtsVoice}
        />
      }
    />
  )
}

/** 覆盖导入的二次确认，叠在设置弹窗上 */
const ImportConfirm = ({
  historyImport,
}: {
  historyImport: ReturnType<typeof useHistoryImport>
}) => {
  const t = useTranslate()
  return (
    <Modal
      title={t('historyImportConfirmTitle')}
      className={styles.importConfirm}
      onClose={historyImport.cancel}
      footer={
        <>
          <Button variant="outlined" size="m" autoFocus onClick={historyImport.cancel}>
            {t('cancel')}
          </Button>
          <Button variant="dangerOutlined" size="m" onClick={() => void historyImport.confirm()}>
            {t('historyImportConfirm')}
          </Button>
        </>
      }
    >
      <div className={styles.importConfirmText}>{t('historyImportConfirmDescription')}</div>
      <label className={styles.importConfirmToggle}>
        <input
          type="checkbox"
          checked={historyImport.includeAttachments}
          onChange={historyImport.toggleAttachments}
        />
        <span>{t('historyImportAttachments')}</span>
      </label>
      <div className={styles.importConfirmHint}>{t('historyImportAttachmentsHint')}</div>
    </Modal>
  )
}

/**
 * 设置面板底部的版本行。
 *
 * 读原生 `getEnvironment()`（与启动日志同源），所以设备上看到的版本号
 * 就是 APK 的真实版本，不依赖任何硬编码常量。
 */
const appVersionLine = (): string => {
  const bridge = (window as { __deepsleepNative?: { getEnvironment?: () => string } })
    .__deepsleepNative
  if (typeof bridge?.getEnvironment !== 'function') {
    return 'Deepsleep'
  }
  try {
    const info = JSON.parse(bridge.getEnvironment()) as {
      versionName?: string
      versionCode?: number
    }
    if (!info.versionName) {
      return 'Deepsleep'
    }
    return info.versionCode === undefined
      ? `Deepsleep ${info.versionName}`
      : `Deepsleep ${info.versionName} (${info.versionCode})`
  } catch {
    return 'Deepsleep'
  }
}

const themeOptions: { value: ThemePreference; label: TranslationKey; icon: ReactNode }[] = [
  {
    value: 'light',
    label: 'avatarMenuSettingsDialogThemeSelectLightOption',
    icon: <IconLightOutline16 />,
  },
  {
    value: 'dark',
    label: 'avatarMenuSettingsDialogThemeSelectDarkOption',
    icon: <IconDarkOutline16 />,
  },
  {
    value: 'system',
    label: 'avatarMenuSettingsDialogThemeSelectSystemOption',
    icon: <IconFollowsystemOutline16 />,
  },
]

/**
 * 主题项：标题下方浅色 / 深色 / 跟随系统三个选块。
 * 与下方语言选项连续排列。
 */
const ThemeSetting = () => {
  const t = useTranslate()
  const themePreference = useSettings((state) => state.themePreference)
  const label = t('avatarMenuSettingsDialogThemeItemLabel')
  return (
    <div className={styles.theme}>
      {label}
      <div role="radiogroup" aria-label={label} className={styles.themeOptions}>
        {themeOptions.map((option) => (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={themePreference === option.value}
            className={clsx(
              styles.themeOption,
              themePreference === option.value && styles.themeOptionSelected
            )}
            onClick={() => setThemePreference(option.value)}
          >
            {option.icon}
            {t(option.label)}
          </button>
        ))}
      </div>
    </div>
  )
}

/** `reason` 为失败原因的文案 key，展示时按当前语言翻译后填入 `message` 参数。 */
type Status = (TranslationMessage & { error?: boolean; reason?: TranslationKey }) | null

/** 导出失败附带原因：预期的错误用对应文案作原因，其他错误用错误信息。 */
const errorStatus = (key: TranslationKey, error: unknown): Status => ({
  key,
  ...(error instanceof BackupError
    ? { reason: error.key }
    : { params: { message: error instanceof Error ? error.message : String(error) } }),
  error: true,
})

const SettingCell = ({
  label,
  description,
  status,
  action,
  className,
}: {
  label: string
  description?: string
  status: Status
  action: ReactNode
  className?: string
}) => {
  const t = useTranslate()
  return (
    <div className={clsx(styles.cell, styles.row, className)}>
      <div className={styles.text}>
        <div className={styles.label}>{label}</div>
        {status || description ? (
          <div className={clsx(styles.description, status?.error && styles.error)}>
            {status
              ? t(status.key, status.reason ? { message: t(status.reason) } : status.params)
              : description}
          </div>
        ) : null}
      </div>
      {action}
    </div>
  )
}

/** 选文件后先提示覆盖；确认后才打开归档并执行导入，任何错误都提示导入失败。 */
const useHistoryImport = () => {
  const [file, setFile] = useState<File | null>(null)
  const [includeAttachments, setIncludeAttachments] = useState(false)
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<ImportProgress | null>(null)
  const [status, setStatus] = useState<Status>(null)
  const importing = useRef(false)

  /** 选完先给默认口径：小包连图片一起导，大包先只导正文，确认框里可以改。 */
  const select = (next: File) => {
    setStatus(null)
    setIncludeAttachments(next.size <= ATTACHMENT_SIZE_LIMIT_MB * 1024 * 1024)
    setFile(next)
  }

  const confirm = async () => {
    if (!file || importing.current) {
      return
    }
    importing.current = true
    setFile(null)
    setBusy(true)
    setStatus(null)
    try {
      const result = await importHistory(file, { includeAttachments }, setProgress)
      setStatus(
        result.skipped > 0
          ? {
              key: 'historyImportedWithSkipped',
              params: { count: result.imported, skipped: result.skipped },
            }
          : {
              key: result.imported === 1 ? 'historyImportedOne' : 'historyImported',
              params: { count: result.imported },
            }
      )
    } catch {
      setStatus({ key: 'historyImportFailed', error: true })
    } finally {
      importing.current = false
      setBusy(false)
      setProgress(null)
    }
  }

  return {
    file,
    busy,
    progress,
    status,
    includeAttachments,
    toggleAttachments: () => setIncludeAttachments((value) => !value),
    select,
    cancel: () => setFile(null),
    confirm,
  }
}

/** 导入进度：按已写入的明文字节算百分比，标题显示当前会话跑到了哪一个。 */
const ImportProgressBar = ({ progress }: { progress: ImportProgress }) => {
  const t = useTranslate()
  const percent =
    progress.totalBytes > 0
      ? Math.min(100, Math.round((progress.bytes / progress.totalBytes) * 100))
      : Math.min(100, Math.round((progress.done / Math.max(1, progress.total)) * 100))
  return (
    <div className={styles.progressRow}>
      <div className={styles.progressLabel}>
        {t('historyImportWriting', {
          done: progress.done,
          total: progress.total,
          percent,
        })}
      </div>
      <div className={styles.progressTrack}>
        <div className={styles.progressFill} style={{ width: `${percent}%` }} />
      </div>
    </div>
  )
}

/** 账户余额：点开设置时自动查一次，也可手动刷新。 */
const BalanceSetting = () => {
  const t = useTranslate()
  const apiKey = useSettings((state) => state.apiKey)
  const [state, setState] = useState<
    | { kind: 'idle' }
    | { kind: 'loading' }
    | { kind: 'ok'; text: string; detail: string }
    | { kind: 'error'; text: string }
  >({ kind: 'idle' })

  const load = useCallback(async () => {
    if (!apiKey) {
      setState({ kind: 'error', text: t('balanceMissingKey') })
      return
    }
    setState({ kind: 'loading' })
    try {
      const balance = await fetchBalance()
      setState({
        kind: 'ok',
        text: formatBalance(balance),
        detail: `${t('balanceGranted')} ${balance.granted.toFixed(2)} · ${t('balanceToppedUp')} ${balance.toppedUp.toFixed(2)}`,
      })
    } catch {
      setState({ kind: 'error', text: t('balanceFailed') })
    }
  }, [apiKey, t])

  useEffect(() => {
    void load()
  }, [load])

  return (
    <SettingCell
      label={t('balance')}
      description={
        state.kind === 'ok'
          ? `${state.text} · ${state.detail}`
          : state.kind === 'error'
            ? state.text
            : t('balanceDescription')
      }
      status={null}
      action={
        <Button
          variant="outlined"
          size="m"
          className={styles.cellButton}
          onClick={() => void load()}
        >
          {t('balanceRefresh')}
        </Button>
      }
    />
  )
}

/** 导入 = 覆盖：用选中文件替换本地全部会话与附件。 */
const ImportHistory = ({
  historyImport,
  disabled,
}: {
  historyImport: ReturnType<typeof useHistoryImport>
  disabled: boolean
}) => {
  const t = useTranslate()
  const inputRef = useRef<HTMLInputElement>(null)

  return (
    <SettingCell
      label={t('historyImport')}
      description={t('historyImportDescription')}
      status={historyImport.status}
      action={
        <>
          <Button
            variant="outlined"
            size="m"
            className={clsx(styles.cellButton, styles.uploadButton)}
            disabled={disabled}
            onClick={() => inputRef.current?.click()}
          >
            <IconUploadOutline14 />
            {t('upload')}
          </Button>
          <input
            ref={inputRef}
            type="file"
            accept=".zip,application/zip,application/x-zip-compressed"
            hidden
            onChange={(event) => {
              const file = event.target.files?.[0]
              event.target.value = ''
              if (file) {
                historyImport.select(file)
              }
            }}
          />
        </>
      }
    />
  )
}

/** 将全部会话及图片导出为官方格式的 ZIP：手机上直接落盘，桌面浏览器触发下载。 */
const ExportHistory = ({ disabled }: { disabled: boolean }) => {
  const t = useTranslate()
  const empty = useChatStore((state) => state.sessions.length === 0)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<Status>(null)

  const onExport = async () => {
    setBusy(true)
    setStatus(null)
    try {
      const outcome = await exportHistory()
      if (outcome.path !== undefined) {
        // APK：原生桥已经把 ZIP 写到用户选的位置，不需要（也做不到）走下载。
        setStatus({ key: 'historyExportedTo', params: { path: outcome.path } })
        return
      }
      if (outcome.blob === undefined) {
        throw new Error('export produced nothing')
      }
      const url = URL.createObjectURL(outcome.blob)
      const link = document.createElement('a')
      link.href = url
      link.download = outcome.name
      link.click()
      setTimeout(() => URL.revokeObjectURL(url), 10_000)
    } catch (error) {
      // 导出失败在 APK 里没有别的观测手段：这行会经 onConsoleMessage 进 logcat。
      // eslint-disable-next-line no-console
      console.error('[export] failed', error)
      setStatus(errorStatus('historyExportFailed', error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <SettingCell
      label={t('exportAllLabel')}
      description={t('historyExportDescription')}
      status={status}
      action={
        <Button
          variant="outlined"
          size="m"
          className={styles.cellButton}
          disabled={disabled || busy || empty}
          onClick={() => void onExport()}
        >
          <IconDownloadOutline16 />
          {t('exportAllDownload')}
        </Button>
      }
    />
  )
}
