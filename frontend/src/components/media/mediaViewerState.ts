import { create } from 'zustand'

/** 全屏预览的目标：图片走 `<img>`，其他类型（PDF / 文本等）走 `<iframe>`。 */
export type MediaViewerTarget = {
  /** 本地 objectURL（IndexedDB 里的原件） */
  url: string
  name: string
  kind: 'image' | 'other'
}

type MediaViewerState = {
  target: MediaViewerTarget | null
}

export const useMediaViewer = create<MediaViewerState>(() => ({ target: null }))

/**
 * 在应用内预览附件。
 *
 * 为什么不用 `<a target="_blank">`：WebView 里 `target=_blank` 会开一个新窗口，
 * 而我们没有给新窗口任何容器（blob: 地址也传不过去），结果是黑屏；再按返回键，
 * WebView 的历史被弹掉，SPA 重新加载成「新对话」。改成应用内浮层后，既不离开
 * 页面，返回键也只是关掉浮层。
 */
export const openMediaViewer = (target: MediaViewerTarget) => {
  useMediaViewer.setState({ target })
}

export const closeMediaViewer = () => {
  useMediaViewer.setState({ target: null })
}
