// 模拟老 WebView：让 dvh 不被识别（把 CSS 里的 100dvh/calc(dvh) 声明整条去掉），
// 验证兜底是否生效——框架仍然占满视口、内容可见。
import { chromium } from 'playwright'
import { readFileSync } from 'node:fs'
const browser = await chromium.launch({ channel: 'msedge', headless: true })
const context = await browser.newContext({ viewport: { width: 412, height: 915 }, isMobile: true })
await context.addInitScript(() => localStorage.setItem('deepsleep:locale', 'zh-CN'))
const page = await context.newPage()
// 用 CSSStyleSheet 过滤：把含 dvh 的规则丢弃，等价于不支持 dvh 的浏览器
await page.route('**/static/css/*.css', async (route) => {
  const response = await route.fetch()
  const css = await response.text()
  const stripped = css.replace(/[^{}]*\{[^{}]*dvh[^{}]*\}/g, '')
  await route.fulfill({ response, body: stripped })
})
await page.goto('http://127.0.0.1:8123/', { waitUntil: 'networkidle' })
await page.waitForTimeout(900)
const geo = await page.evaluate(() => {
  const frame = document.querySelector('[class*="frame"]')
  const rect = frame?.getBoundingClientRect()
  return {
    frame: rect ? `${Math.round(rect.width)}x${Math.round(rect.height)}` : 'none',
    textLen: (document.body.innerText ?? '').trim().length,
    viewport: `${window.innerHeight}`,
  }
})
const checks = [
  ['无 dvh 时框架仍有高度（不被塌成 0）', geo.frame !== 'none' && Number(geo.frame.split('x')[1]) > 300],
  ['框架高度接近视口高度', Math.abs(Number(geo.frame.split('x')[1]) - Number(geo.viewport)) < 40],
  ['界面内容可见（有文本）', geo.textLen > 50],
]
for (const [n, ok] of checks) console.log(`${ok ? 'OK  ' : 'FAIL'} ${n}`)
console.log(`frame=${geo.frame} viewport=${geo.viewport} 文本=${geo.textLen}`)
await page.screenshot({ path: 'D:/AIcoding/test1/自用软件/Deepsleep/.shots/360-no-dvh.png' })
await browser.close()
process.exitCode = checks.every(([, ok]) => ok) ? 0 : 1
