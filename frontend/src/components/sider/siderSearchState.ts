import { create } from 'zustand'

/**
 * 侧边栏搜索框的控制位。
 *
 * 顶栏的搜索按钮只在移动端出现：点它通过 focus 计数直接打开搜索面板。
 * 用自增计数而不是布尔值，连续点两次也能再次触发聚焦。
 */
export const useSiderSearch = create<{ focus: number }>(() => ({ focus: 0 }))

export const focusSiderSearch = () => useSiderSearch.setState((state) => ({ focus: state.focus + 1 }))
