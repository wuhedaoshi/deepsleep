export const services = ['chat', 'search', 'fetch', 'asr', 'tts'] as const
export type Service = (typeof services)[number]
export type Connection = { provider: string; base: string; key: string; model: string }
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
    return { provider, base: url.href.replace(/\/+$/, ''), key: key.trim(), model: model.trim() }
  } catch {
    return null
  }
}

export const connectionFor = (
  settings: { apiMode: string; connections: Connections },
  service: Service
) => (settings.apiMode === 'standard' ? settings.connections[service] : undefined)

export const bearer = (key: string) => (key ? { Authorization: 'Bearer ' + key } : undefined)
