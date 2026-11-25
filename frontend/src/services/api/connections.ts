export const services = ['chat', 'search', 'fetch', 'asr', 'tts'] as const
export type Service = (typeof services)[number]
export type CustomProvider = {
  id: string
  name: string
  kind: 'chat' | 'tools'
  base: string
  key: string
}
export type OpenCodeProtocol = 'chat-completions' | 'responses' | 'messages'
export type ExternalEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export const externalEfforts: ExternalEffort[] = ['low', 'medium', 'high', 'xhigh', 'max']
export type Connection = {
  provider: string
  base: string
  key: string
  model: string
  profileId?: string
  protocol?: OpenCodeProtocol
  effort?: ExternalEffort
  contextWindow?: number
  maxOutput?: number
}
export type Connections = Partial<Record<Service, Connection>>

export const providerBases = {
  opencode: 'https://opencode.ai/inference/openai/v1',
  siliconflow: 'https://api.siliconflow.cn/v1',
  tavily: 'https://api.tavily.com',
}

export const normalizeConnection = (service: Service, value: Connection): Connection | null => {
  if (!value || typeof value !== 'object') {
    return null
  }
  const { provider, base, key, model } = value
  if ([provider, base, key, model].some((field) => typeof field !== 'string')) {
    return null
  }
  const preset =
    (service === 'chat' && (provider === 'opencode' || provider === 'siliconflow')) ||
    ((service === 'search' || service === 'fetch') && provider === 'tavily')
  if (provider !== 'custom' && !preset) {
    return null
  }
  if (
    (preset && !key.trim()) ||
    (service === 'chat' && !model.trim()) ||
    /[^\x21-\x7e]/.test(key.trim())
  ) {
    return null
  }
  try {
    const url = new URL(preset ? providerBases[provider] : base.trim())
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
      return null
    }
    return {
      provider,
      base: url.href.replace(/\/+$/, ''),
      key: key.trim(),
      model: model.trim(),
      ...(provider === 'opencode' &&
      Number.isSafeInteger(value.contextWindow) &&
      (value.contextWindow ?? 0) > 0
        ? { contextWindow: value.contextWindow }
        : {}),
      ...(provider === 'opencode' &&
      Number.isSafeInteger(value.maxOutput) &&
      (value.maxOutput ?? 0) > 0
        ? { maxOutput: value.maxOutput }
        : {}),
      ...(provider === 'opencode' &&
      (value.protocol === 'chat-completions' ||
        value.protocol === 'responses' ||
        value.protocol === 'messages')
        ? { protocol: value.protocol }
        : {}),
      ...(service === 'chat' && value.effort && externalEfforts.includes(value.effort)
        ? { effort: value.effort }
        : {}),
      ...(provider === 'custom' && typeof value.profileId === 'string'
        ? { profileId: value.profileId }
        : {}),
    }
  } catch {
    return null
  }
}

export const normalizeCustomProvider = (entry: CustomProvider): CustomProvider | null => {
  if (
    !entry ||
    typeof entry.id !== 'string' ||
    !entry.id.startsWith('custom:') ||
    typeof entry.name !== 'string' ||
    !entry.name.trim() ||
    !['chat', 'tools'].includes(entry.kind)
  ) {
    return null
  }
  const connection = normalizeConnection('search', { ...entry, provider: 'custom', model: '' })
  return connection
    ? {
        id: entry.id,
        name: entry.name.trim().slice(0, 60),
        kind: entry.kind,
        base: connection.base,
        key: connection.key,
      }
    : null
}

export const connectionFor = (
  settings: {
    apiMode: string
    connections: Connections
    providerKeys?: Record<string, string>
    customProviders?: CustomProvider[]
  },
  service: Service
) => {
  const connection = settings.apiMode === 'standard' ? settings.connections[service] : undefined
  if (!connection) {
    return undefined
  }
  if (connection.provider === 'custom') {
    const profile = settings.customProviders?.find((item) => item.id === connection.profileId)
    return profile ? { ...connection, base: profile.base, key: profile.key } : connection
  }
  const key = settings.providerKeys?.[connection.provider]
  return key === undefined ? connection : { ...connection, key }
}

export const bearer = (key: string) => (key ? { Authorization: 'Bearer ' + key } : undefined)

export const openCodeProtocol = (model: string): OpenCodeProtocol =>
  model.startsWith('gpt-')
    ? 'responses'
    : model.startsWith('claude-')
      ? 'messages'
      : 'chat-completions'

export const siliconFlowEfforts = (model: string): ExternalEffort[] =>
  ['Pro/deepseek-ai/DeepSeek-V4', 'deepseek-ai/DeepSeek-V4-Flash', 'Pro/zai-org/GLM-5.2'].includes(
    model
  )
    ? ['high', 'max']
    : []
