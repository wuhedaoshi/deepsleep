import { API_ORIGIN, readBodyText, request } from './client.js'
import {
  bearer,
  externalEfforts,
  providerBases,
  type CustomProvider,
  type ExternalEffort,
  type OpenCodeProtocol,
} from './connections.js'

export type CatalogProvider = 'deepseek' | 'opencode' | 'siliconflow'

export type OpenCodeModel = {
  protocol: OpenCodeProtocol
  efforts: ExternalEffort[]
  contextWindow?: number
  maxOutput?: number
}
export type ModelCatalog = { models: string[]; routes: Record<string, OpenCodeModel> }

export const fetchProviderModels = async (
  provider: CatalogProvider | CustomProvider,
  key: string,
  signal: AbortSignal
): Promise<ModelCatalog> => {
  const bridge = (globalThis as { __deepsleepNative?: { getOpenCodeNonce?: () => string } })
    .__deepsleepNative
  const nonce = provider === 'opencode' ? bridge?.getOpenCodeNonce?.() : undefined
  const url =
    typeof provider === 'object'
      ? provider.base + '/models'
      : {
          deepseek: API_ORIGIN + '/models',
          opencode: nonce ? '/api/opencode/models' : 'https://opencode.ai/console/api/v1/models',
          siliconflow: providerBases.siliconflow + '/models?sub_type=chat',
        }[provider]
  const response = await request(
    url,
    {
      headers: { ...bearer(key), ...(nonce ? { 'X-Deepsleep-OpenCode': nonce } : {}) },
      redirect: 'error',
      signal,
    },
    { responseTimeoutMs: 12_000, errorBodyTimeoutMs: 3000 }
  )
  const body = JSON.parse(
    await readBodyText(response, { signal, timeoutMs: 10_000, maxChars: 4_000_000 })
  )
  const routes: Record<string, OpenCodeModel> = Object.create(null)
  if (provider === 'opencode') {
    for (const value of Object.values(body?.opencode?.models ?? {})) {
      const entry = value as {
        id?: string
        limit?: { context?: number; output?: number }
        api?: Partial<Record<OpenCodeProtocol, unknown>>
        capabilities?: { reasoning?: { effort?: unknown } }
        cost?: { text?: { input?: { price?: number }; output?: { price?: number } } }
      } | null
      if (
        typeof entry?.id !== 'string' ||
        !entry.id ||
        entry.id.length > 200 ||
        /(?:^|-)free$/.test(entry.id) ||
        (entry.cost?.text?.input?.price === 0 && entry.cost?.text?.output?.price === 0)
      ) {
        continue
      }
      const protocol = (['chat-completions', 'responses', 'messages'] as const).find(
        (kind) => entry.api?.[kind]
      )
      if (!protocol) {
        continue
      }
      const levels = entry.capabilities?.reasoning?.effort
      routes[entry.id] = {
        protocol,
        ...(entry.limit?.context ? { contextWindow: entry.limit.context } : {}),
        ...(entry.limit?.output ? { maxOutput: entry.limit.output } : {}),
        efforts: Array.isArray(levels)
          ? externalEfforts.filter((effort) => levels.includes(effort))
          : [],
      }
    }
  }
  const models: unknown[] =
    provider === 'opencode'
      ? Object.keys(routes)
      : Array.isArray(body?.data)
        ? body.data.map((model: { id?: unknown } | null) => model?.id)
        : []
  const ids = [
    ...new Set(
      models.filter(
        (id): id is string =>
          typeof id === 'string' &&
          id.length > 0 &&
          id.length <= 200 &&
          (provider !== 'deepseek' || id === 'deepseek-flash' || id === 'deepseek-v4-pro')
      )
    ),
  ].sort()
  return { models: ids, routes }
}
