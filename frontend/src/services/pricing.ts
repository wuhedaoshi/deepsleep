import type { MessageUsage } from './api/types.js'

/**
 * DeepSeek 定价（每百万 tokens，单位元），按官方价格页 2026-11 口径。
 * 空闲时段是高峰时段的一半：北京时间周一至周五 9-12、14-18 为高峰，其余（含周末）为空闲。
 */
type Price = { hit: number; miss: number; output: number }

const PRICES: Record<'peak' | 'idle', Price> = {
  peak: { hit: 0.04, miss: 2, output: 8 },
  idle: { hit: 0.02, miss: 1, output: 4 },
}

/** 联网搜索按次计费：每 1000 次 5 元。 */
const SEARCH_PRICE_PER_CALL = 5 / 1000

const beijingParts = (at: Date) => {
  const format = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Shanghai',
    hour12: false,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
  })
  const parts: Record<string, string> = {}
  for (const part of format.formatToParts(at)) {
    parts[part.type] = part.value
  }
  return {
    weekday: parts.weekday ?? '',
    hour: Number(parts.hour ?? '0'),
    minute: Number(parts.minute ?? '0'),
  }
}

/** 是否处在高峰时段（周末全天空闲；法定节假日不在此处判断，按周末规则近似）。 */
export const isPeakHour = (at: Date = new Date()): boolean => {
  const { weekday, hour, minute } = beijingParts(at)
  if (weekday === 'Sat' || weekday === 'Sun') {
    return false
  }
  const minutes = hour * 60 + minute
  const morning = minutes >= 9 * 60 && minutes < 12 * 60
  const afternoon = minutes >= 14 * 60 && minutes < 18 * 60
  return morning || afternoon
}

export type CostBreakdown = {
  /** 总花费（元） */
  total: number
  /** 各分项（元） */
  cached: number
  uncached: number
  output: number
  search: number
  peak: boolean
}

/** 按用量算这次请求的花费；usage 缺失时返回 null。 */
export const costOf = (
  usage: MessageUsage | undefined,
  at: Date = new Date()
): CostBreakdown | null => {
  if (!usage) {
    return null
  }
  const peak = isPeakHour(at)
  const price = PRICES[peak ? 'peak' : 'idle']
  const cached = (usage.cache_read_input_tokens ?? 0) * price.hit
  const uncached =
    ((usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0)) * price.miss
  const output = (usage.output_tokens ?? 0) * price.output
  const searches =
    (usage.server_tool_use?.web_search_requests ?? 0) + (usage.server_tool_use?.tool_search ?? 0)
  const search = searches * SEARCH_PRICE_PER_CALL
  return {
    total: (cached + uncached + output) / 1_000_000 + search,
    cached: cached / 1_000_000,
    uncached: uncached / 1_000_000,
    output: output / 1_000_000,
    search,
    peak,
  }
}

/** 金额显示：小额给到 4 位小数，避免全变成 0.00。 */
export const formatCost = (yuan: number): string => {
  if (yuan === 0) {
    return '¥0'
  }
  if (yuan < 0.01) {
    return `¥${yuan.toFixed(4)}`
  }
  if (yuan < 1) {
    return `¥${yuan.toFixed(3)}`
  }
  return `¥${yuan.toFixed(2)}`
}
