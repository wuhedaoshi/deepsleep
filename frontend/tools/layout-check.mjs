// 窄屏排版检查：用已装好的 Edge 在 390×844 渲染真实 bundle，截输入框那一行。
// 只为回答「竖屏下按钮有没有被挤变形」，不涉及业务逻辑。
import { chromium } from 'playwright'

const url = process.argv[2] ?? 'http://127.0.0.1:8123/'
const shots = [
  { name: 'narrow-390', width: 390, height: 844 },
  { name: 'narrow-360', width: 360, height: 780 },
]

const browser = await chromium.launch({ channel: 'msedge', headless: true })
for (const shot of shots) {
  const context = await browser.newContext({ viewport: { width: shot.width, height: shot.height } })
  // 预置 API Key：否则移动端会弹设置页挡住输入框
  await context.addInitScript(() => {
    localStorage.setItem('deepsleep:api-key', 'sk-layout-check')
    localStorage.setItem('deepsleep:locale', 'zh-CN')
  })
  const page = await context.newPage()
  await page.goto(url, { waitUntil: 'networkidle' })
  await page.waitForTimeout(1200)
  await page.screenshot({ path: `D:/AIcoding/test1/自用软件/Deepsleep/.shots/${shot.name}.png` })
  // 顺手量一下那一行里各控件的实际宽度，比肉眼更可靠
  const metrics = await page.evaluate(() => {
    const footer = document.querySelector('[class*="footer"]') ?? document.body
    const buttons = [...footer.querySelectorAll('button')].map((node) => ({
      text: (node.textContent ?? '').trim().slice(0, 8),
      width: Math.round(node.getBoundingClientRect().width),
      height: Math.round(node.getBoundingClientRect().height),
    }))
    return { viewport: window.innerWidth, buttons }
  })
  console.log(`${shot.name}: 视口 ${metrics.viewport}px，控件 ${metrics.buttons.length} 个`)
  for (const button of metrics.buttons) {
    console.log(`  [${button.text}] ${button.width}×${button.height}`)
  }
  await context.close()
}
await browser.close()
