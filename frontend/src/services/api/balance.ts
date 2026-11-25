import { API_ORIGIN, readBodyText, request } from './client.js'

/** GET /user/balance 的返回结构（字段按官方文档，数值是字符串）。 */
type BalanceResponse = {
  is_available: boolean
  balance_infos: {
    currency: string
    total_balance: string
    granted_balance: string
    topped_up_balance: string
  }[]
}

export type Balance = {
  available: boolean
  currency: string
  total: number
  granted: number
  toppedUp: number
}

const symbolOf = (currency: string) => (currency.toUpperCase() === 'CNY' ? '¥' : `${currency} `)

export const formatBalance = (balance: Balance): string =>
  `${symbolOf(balance.currency)}${balance.total.toFixed(2)}`

/** 查询账户余额；网络或鉴权失败时抛出，由界面提示重试。 */
export const fetchBalance = async (apiKey: string, signal: AbortSignal): Promise<Balance> => {
  const response = await request(API_ORIGIN + '/user/balance', {
    headers: { Authorization: `Bearer ${apiKey}` },
    redirect: 'error',
    signal,
  }, { responseTimeoutMs: 10_000, errorBodyTimeoutMs: 3000 })
  const data = JSON.parse(await readBodyText(response, { signal, timeoutMs: 5000, maxChars: 16384 })) as BalanceResponse
  const info = data.balance_infos?.[0]
  if (!info) {
    throw new Error('balance empty')
  }
  const total = Number(info.total_balance)
  const granted = Number(info.granted_balance)
  const toppedUp = Number(info.topped_up_balance)
  if (![total, granted, toppedUp].every(Number.isFinite) || typeof info.currency !== 'string') {
    throw new Error('balance invalid')
  }
  return {
    available: data.is_available === true,
    currency: info.currency,
    total,
    granted,
    toppedUp,
  }
}
