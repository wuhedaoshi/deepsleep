import { chromium } from 'playwright'
const url = 'http://127.0.0.1:8123/'
const archive = 'D:/AIcoding/test1/自用软件/Deepsleep/.shots/tiny-image.zip'
const browser = await chromium.launch({ channel: 'msedge', headless: true })
const context = await browser.newContext({ viewport: { width: 420, height: 900 } })
// 首次安装状态：不预置 API Key，让设置页自动弹出
await context.addInitScript(() => { localStorage.setItem('deepsleep:locale', 'zh-CN') })
const page = await context.newPage()
const errors = []
page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`))
page.on('console', (message) => { if (message.type() === 'error') errors.push(`console: ${message.text()}`) })
await page.goto(url, { waitUntil: 'networkidle' })
await page.waitForTimeout(900)

const sider = await page.evaluate(() => {
  const t = document.querySelector('button[aria-label="打开边栏"]')
  t?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  return Boolean(t)
})
await page.waitForTimeout(400)

// 设置应当已经自动打开（首次没有 Key）；没开就自己点
const hasDialog = await page.evaluate(() => document.body.innerText.includes('设置'))
if (!hasDialog || await page.getByRole('button', { name: '设置' }).count()) {
  const btn = page.getByRole('button', { name: '设置' }).first()
  if (await btn.count()) { try { await btn.click({ timeout: 3000 }) } catch {} }
}
await page.waitForTimeout(500)
await page.getByText('数据管理', { exact: true }).first().click().catch(() => {})
await page.waitForTimeout(400)

// 选文件 + 填 Key（首次使用场景）
const inputs = page.locator('input[type=file]')
const accepts = await inputs.evaluateAll((nodes) => nodes.map((n) => n.accept))
const zipIndex = accepts.findIndex((a) => a.includes('application/zip'))
if (zipIndex >= 0) {
  await inputs.nth(zipIndex).setInputFiles(archive)
  await page.waitForTimeout(600)
  const attach = page.getByLabel('同时导入图片附件')
  if (await attach.count()) await attach.first().check({ force: true }).catch(() => {})
  const confirm = page.getByRole('button', { name: '确认导入' })
  if (await confirm.count()) await confirm.first().click()
  await page.waitForTimeout(800)
}

// 填 Key 并点「确定」
const keyField = page.locator('input[placeholder="请输入 API Key"]').first()
if (await keyField.count()) { await keyField.fill('sk-first-run-test') }
const ok = page.getByRole('button', { name: '确定' })
if (await ok.count()) { await ok.first().click().catch(() => {}) }
await page.waitForTimeout(2500)

const body = await page.evaluate(() => document.body.innerText.slice(0, 400))
const crashed = body.includes('界面出错了')
const white = body.trim() === '' || body.includes('今天有什么可以帮到你') === false && body.includes('设置') === false
console.log(`场景：首次使用 → 导入 + 填 Key + 确定`)
console.log(`错误边界接管: ${crashed}`)
console.log(`正文片段: ${body.replace(/\n+/g, ' | ').slice(0, 220)}`)
console.log(`捕获到的错误: ${errors.length === 0 ? '无' : errors.slice(0, 3).join(' ⏎ ')}`)
await page.screenshot({ path: 'D:/AIcoding/test1/自用软件/Deepsleep/.shots/320-first-run.png' })
await browser.close()
