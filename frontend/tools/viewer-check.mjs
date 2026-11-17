// 在真实浏览器里验证「点开图片」这条链路：导入一个只有一条会话的小包 →
// 打开会话 → 点缩略图 → 断言浮层里是真实图片、且没有走 window.open →
// 按 Esc 关掉后仍在会话里（不是回到新对话）。
//
// 用法：node tools/viewer-check.mjs <小包.zip> [http://127.0.0.1:8123/]
import { chromium } from 'playwright'

const archive = process.argv[2]
const url = process.argv[3] ?? 'http://127.0.0.1:8123/'
if (!archive) throw new Error('缺少归档路径参数')

const browser = await chromium.launch({ channel: 'msedge', headless: true })
const context = await browser.newContext({ viewport: { width: 420, height: 900 } })
await context.addInitScript(() => {
  localStorage.setItem('deepsleep:api-key', 'sk-viewer-check')
  localStorage.setItem('deepsleep:locale', 'zh-CN')
  // 记录任何 window.open：修好之后不该再出现
  window.__openedWindows = []
  const original = window.open
  window.open = (...args) => {
    window.__openedWindows.push(String(args[0]))
    return original.apply(window, args)
  }
})
const page = await context.newPage()
page.on('pageerror', (error) => console.log(`[pageerror] ${error.message}`))
await page.goto(url, { waitUntil: 'networkidle' })
await page.waitForTimeout(800)

/** 窄屏下侧栏默认收起，先点「打开边栏」 */
const openSider = async () => {
  // 抽屉开着的时候遮罩会挡住一切点击，先看状态再决定要不要点
  const state = await page.evaluate(() => {
    const layer = document.querySelector('[class*="drawerLayer"]')
    const isOpen = layer?.getAttribute('data-open') === 'true'
    if (isOpen) return 'open'
    const toggle = document.querySelector('button[aria-label="打开边栏"]')
    toggle?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    return toggle ? 'opened' : 'missing'
  })
  await page.waitForTimeout(500)
  return state
}

// 1) 设置 → 数据管理 → 选文件导入
await openSider()
await page.getByRole('button', { name: '设置' }).first().click()
await page.waitForTimeout(500)
await page.getByText('数据管理', { exact: true }).first().click()
await page.waitForTimeout(400)

const inputs = page.locator('input[type=file]')
const accepts = await inputs.evaluateAll((nodes) => nodes.map((node) => node.accept))
// 归档用的是最后一个 input（accept 明确写了 .zip），前面几个分别是附件/图片/相册
const zipIndex = accepts.findIndex((accept) => accept.includes('application/zip') || accept.startsWith('.zip'))
console.log(`file input 共 ${accepts.length} 个，归档输入框索引=${zipIndex}`)
await inputs.nth(zipIndex < 0 ? 0 : zipIndex).setInputFiles(archive)
await page.waitForTimeout(600)

const attach = page.getByLabel('同时导入图片附件')
if (await attach.count()) {
  await attach.first().check({ force: true })
}
await page.getByRole('button', { name: '确认导入' }).click()
await page.waitForFunction(() => document.body.innerText.includes('已导入'), { timeout: 90_000 })
console.log('OK  导入完成')
await page.keyboard.press('Escape')
await page.waitForTimeout(500)

// 2) 打开刚导入的会话（列表第一条）
await openSider()
const firstSession = page.locator('[class*="session"], [class*="item"]').filter({ hasText: /\S/ }).first()
// 抽屉的遮罩会挡住 Playwright 的命中检测，直接在页面里派发一次点击（真实事件，只是跳过命中检查）
const opened = await page.evaluate(() => {
  const rows = [...document.querySelectorAll('button, [role="button"], [class*="item"]')]
  const target = rows.find((node) => {
    const text = (node.textContent ?? '').trim()
    return text.length > 0 && !/设置|搜索|新对话|上传|导出|删除|取消|确认/.test(text)
  })
  if (!target) return ''
  target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  return (target.textContent ?? '').trim().slice(0, 20)
})
console.log(`打开的会话：${opened}`)
await page.waitForTimeout(900)

// 3) 点缩略图
const thumb = page.locator('button:has(img) img').first()
await thumb.waitFor({ state: 'visible', timeout: 15_000 })
const thumbSize = await thumb.evaluate((img) => ({ w: img.naturalWidth, h: img.naturalHeight }))
await thumb.click({ force: true })
await page.waitForTimeout(700)

const overlay = page.locator('[role="dialog"][aria-modal="true"]')
const overlayVisible = (await overlay.count()) > 0
const imageLoaded = overlayVisible
  ? await overlay
      .locator('img')
      .first()
      .evaluate((img) => img.complete && img.naturalWidth > 0)
  : false
const openedWindows = await page.evaluate(() => window.__openedWindows)

// 4) Esc 关闭后仍在会话里
await page.screenshot({ path: 'D:/AIcoding/test1/自用软件/Deepsleep/.shots/300-viewer-open.png' })
await page.keyboard.press('Escape')
await page.waitForTimeout(600)
const overlayGone = (await overlay.count()) === 0
const stillInSession = await page.evaluate(
  () => !document.body.innerText.includes('今天有什么可以帮到你')
)

const checks = [
  [`缩略图已加载（${thumbSize.w}×${thumbSize.h}）`, thumbSize.w > 0],
  ['点开后出现预览浮层', overlayVisible],
  ['浮层里是真图片（naturalWidth>0）', imageLoaded],
  ['没有再调用 window.open', openedWindows.length === 0],
  ['Esc 关闭浮层', overlayGone],
  ['关闭后仍在会话里，没回到新对话', stillInSession],
]
for (const [name, ok] of checks) {
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}`)
}
await page.screenshot({ path: 'D:/AIcoding/test1/自用软件/Deepsleep/.shots/301-viewer-closed.png' })
await browser.close()
process.exitCode = checks.every(([, ok]) => ok) ? 0 : 1
