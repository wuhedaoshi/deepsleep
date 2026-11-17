import { useEffect } from 'react'
import { closeMobileSider, useMobileSider } from './mobileSiderState.js'

/**
 * 全屏手势：收起状态下整屏任意位置右滑都能拉出抽屉。
 *
 * 代价是要和页面内的横向滚动抢事件，所以方向判定更严：横向位移必须是纵向的
 * 2 倍以上才开始接管，且标记了 data-no-swipe 的区域（如代码块的横向滚动条）
 * 直接跳过。抽屉展开后整屏任意位置左滑都能收起。
 */
/** 松手时判定为“打开”的进度比例。 */
const COMMIT = 0.32
/** 快速滑动（px/ms）即使进度不足也认。 */
const FLICK = 0.35

/**
 * 从触点向上找横向可滚动容器（表格、代码块、横向滚动的列表）。
 * 找到就让滑动手势让路，否则全屏右滑会把页面内的横向滚动全部吃掉。
 */
const inScrollableX = (target: EventTarget | null): boolean => {
  let node = target as HTMLElement | null
  for (let depth = 0; node && depth < 8; depth += 1) {
    const style = window.getComputedStyle(node)
    const overflowX = style.overflowX
    if ((overflowX === 'auto' || overflowX === 'scroll') && node.scrollWidth > node.clientWidth + 2) {
      return true
    }
    node = node.parentElement
  }
  return false
}

const drawerEl = () => document.querySelector('[data-ds-drawer]') as HTMLElement | null
const mainEl = () => document.querySelector('[data-ds-main]') as HTMLElement | null

/**
 * 移动端边缘滑动开合侧边栏，跟随手指实时位移。
 *
 * 关键点是“跟手”：拖动过程直接写 transform，不靠 class 切换，松手才补过渡。
 * 这样才有系统抽屉那种黏手感，而不是到阈值后突然弹开。
 */
export const useEdgeSwipe = (enabled: boolean) => {
  const open = useMobileSider((state) => state.open)

  useEffect(() => {
    if (!enabled) {
      return
    }
    let tracking = false
    let dragging = false
    let startX = 0
    let startY = 0
    let lastX = 0
    let lastTime = 0
    let velocity = 0
    let width = 300

    const apply = (progress: number) => {
      const drawer = drawerEl()
      const main = mainEl()
      const clamped = Math.max(0, Math.min(1, progress))
      if (drawer) {
        drawer.style.transition = 'none'
        drawer.style.transform = `translateX(${(clamped - 1) * 100}%)`
      }
      if (main) {
        main.style.transition = 'none'
        main.style.transform = `translateX(${clamped * 78}%)`
        main.style.borderTopLeftRadius = '16px'
        main.style.borderBottomLeftRadius = '16px'
      }
    }

    const settle = (shouldOpen: boolean) => {
      const drawer = drawerEl()
      const main = mainEl()
      const transition = 'transform 320ms cubic-bezier(0.22, 1, 0.36, 1)'
      if (drawer) {
        drawer.style.transition = transition
        drawer.style.transform = shouldOpen ? 'translateX(0)' : 'translateX(-102%)'
      }
      if (main) {
        main.style.transition = transition
        main.style.transform = shouldOpen ? 'translateX(78%)' : 'translateX(0)'
      }
      const clear = () => {
        for (const el of [drawer, main]) {
          if (!el) continue
          el.style.transition = ''
          el.style.transform = ''
        }
      }
      setTimeout(clear, 340)
      if (shouldOpen) {
        useMobileSider.setState({ open: true })
      } else {
        closeMobileSider()
      }
    }

    const onStart = (event: TouchEvent) => {
      if (event.touches.length !== 1) {
        return
      }
      const touch = event.touches[0]
      if (!open) {
        const target = event.target as HTMLElement | null
        if (target?.closest?.('[data-no-swipe]') || inScrollableX(event.target)) {
          return
        }
      }
      tracking = true
      dragging = false
      startX = touch.clientX
      startY = touch.clientY
      lastX = startX
      lastTime = event.timeStamp
      velocity = 0
      width = Math.min(300, window.innerWidth * 0.78)
    }

    const onMove = (event: TouchEvent) => {
      if (!tracking || event.touches.length !== 1) {
        return
      }
      const touch = event.touches[0]
      const dx = touch.clientX - startX
      const dy = touch.clientY - startY
      if (!dragging) {
        const horizontal = Math.abs(dx)
        const vertical = Math.abs(dy)
        if (!open ? vertical > horizontal * 0.5 : vertical > horizontal) {
          tracking = false
          return
        }
        if (Math.abs(dx) > 6) {
          dragging = true
        } else {
          return
        }
      }
      event.preventDefault()
      const elapsed = Math.max(1, event.timeStamp - lastTime)
      velocity = (touch.clientX - lastX) / elapsed
      lastX = touch.clientX
      lastTime = event.timeStamp
      const progress = open ? 1 + dx / width : dx / width
      apply(progress)
    }

    const onEnd = () => {
      if (!tracking) {
        return
      }
      const wasDragging = dragging
      tracking = false
      dragging = false
      if (!wasDragging) {
        return
      }
      const dx = lastX - startX
      const progress = open ? 1 + dx / width : dx / width
      const shouldOpen = open
        ? !(progress < 1 - COMMIT || velocity < -FLICK)
        : progress > COMMIT || velocity > FLICK
      settle(shouldOpen)
    }

    // 左缘起手用 capture 阶段先拿到事件，避免被页面内的滚动容器吞掉。
    document.addEventListener('touchstart', onStart, { passive: true, capture: true })
    document.addEventListener('touchmove', onMove, { passive: false, capture: true })
    document.addEventListener('touchend', onEnd, { passive: true, capture: true })
    document.addEventListener('touchcancel', onEnd, { passive: true, capture: true })
    return () => {
      document.removeEventListener('touchstart', onStart, { capture: true })
      document.removeEventListener('touchmove', onMove, { capture: true })
      document.removeEventListener('touchend', onEnd, { capture: true })
      document.removeEventListener('touchcancel', onEnd, { capture: true })
    }
  }, [enabled, open])
}
