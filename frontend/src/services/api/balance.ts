import { useSettings } from '../settings.js'

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
export const fetchBalance = async (): Promise<Balance> => {
  const { apiKey } = useSettings.getState()
  if (!apiKey) {
    throw new Error('missing api key')
  }
  const response = await fetch('https://api.deepseek.com/user/balance', {
    headers: { Authorization: `Bearer ${apiKey}` },
  })
  if (!response.ok) {
    throw new Error(`balance ${response.status}`)
  }
  const data = (await response.json()) as BalanceResponse
  const info = data.balance_infos?.[0]
  if (!info) {
    throw new Error('balance empty')
  }
  return {
    available: data.is_available === true,
    currency: info.currency,
    total: Number(info.total_balance),
    granted: Number(info.granted_balance),
    toppedUp: Number(info.topped_up_balance),
  }
}
