import { create } from 'zustand'
import { normalizeConnection, services, type Connection, type Connections, type Service } from './api/connections.js'
import {
  DEFAULT_SYSTEM_PROMPT,
  type ApiMode,
  type ChatModel,
  type SafetyLevel,
  type ThinkingEffort,
} from './api/types.js'
import type { TtsVoice } from './api/speech.js'
import { normalizeLocation, type UserLocation } from './location.js'

export type Locale = 'zh-CN' | 'en-US'

/** 主题偏好；默认跟随系统 */
export type ThemePreference = 'light' | 'dark' | 'system'

/** 本机设置，存 localStorage：API Key、语言、主题、位置、朗读音色、深度思考与智能搜索开关、侧边栏收起状态 */
export type PromptPreset = { id: string; name: string; text: string }

type Settings = {
  connections: Connections
  model: ChatModel
  apiMode: ApiMode
  thinkingEffort: ThinkingEffort
  safetyLevel: SafetyLevel
  promptPresets: PromptPreset[]
  activePromptId: string | null
  apiKey: string | null
  locale: Locale
  themePreference: ThemePreference
  location: UserLocation | null
  ttsVoice: TtsVoice
  thinking: boolean
  search: boolean
  siderCollapsed: boolean
  /** 回车键行为：发送，还是换行（换行时用 Ctrl/⌘+Enter 发送） */
  enterKey: EnterKeyBehavior
  /** null 沿用模型默认，避免升级后把旧默认值固化成本机覆盖。 */
  contextWindowOverride: number | null
}

const KEYS = {
  connections: 'deepsleep:service-connections',
  apiKey: 'deepsleep:api-key',
  model: 'deepsleep:model',
  apiMode: 'deepsleep:api-mode',
  thinkingEffort: 'deepsleep:thinking-effort',
  safetyLevel: 'deepsleep:safety-level',
  prompts: 'deepsleep:prompt-presets',
  locale: 'deepsleep:locale',
  location: 'deepsleep:location',
  themePreference: 'deepsleep:theme-preference',
  ttsVoice: 'deepsleep:tts-voice',
  thinking: 'deepsleep:thinking',
  search: 'deepsleep:search',
  siderCollapsed: 'deepsleep:sider-collapsed',
  enterKey: 'deepsleep:enter-key',
  contextWindowOverride: 'deepsleep:context-window-override',
} as const

const read = (key: string) => {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

const write = (key: string, value: string | null) => {
  try {
    if (value === null) {
      localStorage.removeItem(key)
    } else {
      localStorage.setItem(key, value)
    }
  } catch {
    // 存储不可用时只在内存中生效
  }
}

/** 位置选择模式跟随浏览器语言，与应用内选择的界面语言无关。 */
const readConnections = (): Connections => {
  try {
    const saved = JSON.parse(read(KEYS.connections) ?? '{}')
    const connections: Connections = {}
    for (const service of services) {
      const connection = normalizeConnection(service, saved?.[service])
      if (connection) {connections[service] = connection}
    }
    return connections
  } catch {
    return {}
  }
}

export const isChineseBrowser = (): boolean =>
  (typeof navigator === 'undefined' ? 'zh' : navigator.language).toLowerCase().startsWith('zh')

const initialLocale = (): Locale => {
  const saved = read(KEYS.locale)
  if (saved === 'zh-CN' || saved === 'en-US') {
    return saved
  }
  return isChineseBrowser() ? 'zh-CN' : 'en-US'
}

const initialLocation = (): UserLocation | null => {
  try {
    const location = normalizeLocation(JSON.parse(read(KEYS.location) ?? 'null'))
    if (!location) {
      return null
    }
    return isChineseBrowser()
      ? location.region === 'CN' && location.province
        ? location
        : null
      : { region: location.region }
  } catch {
    return null
  }
}

/** 回车键：send = 直接发送；newline = 插入换行（Ctrl/⌘+Enter 发送） */
export type EnterKeyBehavior = 'send' | 'newline'

/** 默认发送：与一直以来的行为一致，不打断老用户肌肉记忆 */
const initialEnterKey = (): EnterKeyBehavior =>
  read(KEYS.enterKey) === 'newline' ? 'newline' : 'send'

/** 未保存过时跟随系统 */
const initialThemePreference = (): ThemePreference => {
  const saved = read(KEYS.themePreference)
  return saved === 'light' || saved === 'dark' ? saved : 'system'
}

/** 未保存过时使用服务端默认音色 stella（海星） */
const initialTtsVoice = (): TtsVoice => (read(KEYS.ttsVoice) === 'tide' ? 'tide' : 'stella')

const normalizeContextWindow = (value: number | null): number | null =>
  value !== null && Number.isFinite(value) && value > 0 ? value : null

const initialPrompts = (): Pick<Settings, 'promptPresets' | 'activePromptId'> => {
  try {
    const saved = JSON.parse(read(KEYS.prompts) ?? 'null') as {
      presets?: unknown
      activeId?: unknown
    } | null
    const promptPresets = Array.isArray(saved?.presets)
      ? saved.presets.filter(
          (value): value is PromptPreset =>
            value !== null &&
            typeof value.id === 'string' &&
            typeof value.name === 'string' &&
            typeof value.text === 'string'
        )
      : []
    return {
      promptPresets,
      activePromptId: promptPresets.find((item) => item.id === saved?.activeId)?.id ?? null,
    }
  } catch {
    return { promptPresets: [], activePromptId: null }
  }
}

const initialEffort = (): ThinkingEffort => {
  const value = read(KEYS.thinkingEffort)
  return value === 'low' || value === 'max' ? value : 'high'
}

export const useSettings = create<Settings>(() => ({
  connections: readConnections(),
  apiKey: read(KEYS.apiKey),
  apiMode: read(KEYS.apiMode) === 'standard' ? 'standard' : 'extended',
  model: read(KEYS.model) === 'deepseek-v4-pro' ? 'deepseek-v4-pro' : 'deepseek-flash',
  thinkingEffort: initialEffort(),
  safetyLevel: read(KEYS.safetyLevel) === 'low' ? 'low' : 'high',
  ...initialPrompts(),
  locale: initialLocale(),
  location: initialLocation(),
  themePreference: initialThemePreference(),
  ttsVoice: initialTtsVoice(),
  thinking: read(KEYS.thinking) === 'true',
  search: read(KEYS.search) === 'true',
  siderCollapsed: read(KEYS.siderCollapsed) === 'true',
  enterKey: initialEnterKey(),
  contextWindowOverride: normalizeContextWindow(Number(read(KEYS.contextWindowOverride))),
}))

export const setLocale = (locale: Locale) => {
  write(KEYS.locale, locale)
  useSettings.setState({ locale })
}

export const setLocation = (value: UserLocation | null) => {
  const location = normalizeLocation(value)
  write(KEYS.location, location ? JSON.stringify(location) : null)
  useSettings.setState({ location })
}

export const setThemePreference = (themePreference: ThemePreference) => {
  write(KEYS.themePreference, themePreference)
  useSettings.setState({ themePreference })
}

export const setTtsVoice = (ttsVoice: TtsVoice) => {
  write(KEYS.ttsVoice, ttsVoice)
  useSettings.setState({ ttsVoice })
}

export const setConnection = (service: Service, value: Connection | null) => {
  const connection = value && normalizeConnection(service, value)
  if (value && !connection) {return false}
  const connections = { ...useSettings.getState().connections, [service]: connection ?? undefined }
  write(KEYS.connections, JSON.stringify(connections))
  useSettings.setState({ connections })
  return true
}

export const setApiKey = (apiKey: string | null) => {
  write(KEYS.apiKey, apiKey)
  useSettings.setState({ apiKey })
}

export const setThinking = (thinking: boolean) => {
  write(KEYS.thinking, String(thinking))
  useSettings.setState({ thinking })
}

export const setSearch = (search: boolean) => {
  write(KEYS.search, String(search))
  useSettings.setState({ search })
}

export const setSiderCollapsed = (siderCollapsed: boolean) => {
  write(KEYS.siderCollapsed, String(siderCollapsed))
  useSettings.setState({ siderCollapsed })
}
export const setEnterKey = (enterKey: EnterKeyBehavior) => {
  write(KEYS.enterKey, enterKey)
  useSettings.setState({ enterKey })
}

/**
 * 解析用户输入的窗口大小：`1400000` / `1.4m` / `300k` 都认，空串表示恢复默认。
 *
 * 之前用 `type="number"` + `Number()`，`1.4m` 会变成 NaN 而被静默丢弃，
 * 用户以为设置了、其实没生效。
 */
export const parseContextWindowInput = (raw: string): number | null => {
  const text = raw
    .trim()
    .toLowerCase()
    .replace(/[_\s,]/g, '')
  if (text === '') {
    return null
  }
  const match = /^(\d+(?:\.\d+)?)([km])?$/.exec(text)
  if (!match) {
    return null
  }
  const base = Number(match[1])
  if (!Number.isFinite(base) || base <= 0) {
    return null
  }
  const factor = match[2] === 'm' ? 1_000_000 : match[2] === 'k' ? 1_000 : 1
  const tokens = Math.round(base * factor)
  return Number.isSafeInteger(tokens) && tokens > 0 ? tokens : null
}

export const setContextWindowOverride = (value: number | null) => {
  const contextWindowOverride = normalizeContextWindow(value)
  write(
    KEYS.contextWindowOverride,
    contextWindowOverride === null ? null : String(contextWindowOverride)
  )
  useSettings.setState({ contextWindowOverride })
}

export const setModel = (model: ChatModel) => {
  write(KEYS.model, model)
  useSettings.setState({ model })
}

export const setThinkingEffort = (thinkingEffort: ThinkingEffort) => {
  write(KEYS.thinkingEffort, thinkingEffort)
  useSettings.setState({ thinkingEffort })
}

export const setSafetyLevel = (safetyLevel: SafetyLevel) => {
  write(KEYS.safetyLevel, safetyLevel)
  useSettings.setState({ safetyLevel })
}

export const setPromptPreferences = (
  promptPresets: PromptPreset[],
  activePromptId: string | null
) => {
  write(KEYS.prompts, JSON.stringify({ presets: promptPresets, activeId: activePromptId }))
  useSettings.setState({ promptPresets, activePromptId })
}

export const selectedSystemPrompt = ({
  promptPresets,
  activePromptId,
}: Pick<Settings, 'promptPresets' | 'activePromptId'>) =>
  promptPresets.find((preset) => preset.id === activePromptId)?.text.trim() || DEFAULT_SYSTEM_PROMPT

export const setApiMode = (apiMode: ApiMode) => {
  write(KEYS.apiMode, apiMode)
  useSettings.setState({ apiMode })
}
