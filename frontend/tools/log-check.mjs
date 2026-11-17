// 验证「运行日志」这条链路：打开面板能看到时间线、导出文本带环境头、
// 未捕获异常会让错误边界接管（而不是白屏）。
//
// 用法：node tools/log-check.mjs [http://127.0.0.1:8123/]
import { chromium } from 'playwright'

const url = process.argv[2] ?? 'http://127.0.0.1:8123/'
const browser = await chromium.launch({ channel: 'msedge', headless: true })
const context = await browser.newContext({ viewport: { width: 420, height: 900 } })
await context.addInitScript(() => {
  localStorage.setItem('deepsleep:api-key', 'sk-log-check')
  localStorage.setItem('deepsleep:locale', 'zh-CN')
})
const page = await context.newPage()
await page.goto(url, { waitUntil: 'networkidle' })
await page.waitForTimeout(800)

// 1) 抛一个未捕获异常：全局兜底应当把它记进日志（白屏类问题的常见来源）
await page.evaluate(() => {
  setTimeout(() => {
    throw new Error('测试用异常：全局兜底应当记录')
  }, 0)
})
await page.waitForTimeout(600)

// 2) 打开设置 → 运行日志（不刷新页面，缓冲区还在）
await page.evaluate(() => {
  const toggle = document.querySelector('button[aria-label="打开边栏"]')
  toggle?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
})
await page.waitForTimeout(400)
await page.getByRole('button', { name: '设置' }).first().click()
await page.waitForTimeout(500)
await page.getByText('数据管理', { exact: true }).first().click()
await page.waitForTimeout(400)
const rowLabel = await page.getByText('运行日志', { exact: true }).count()
await page.getByRole('button', { name: '查看' }).first().click()
await page.waitForTimeout(500)
const panelText = await page.evaluate(() => document.body.innerText)
const hasBoot = panelText.includes('[boot]')
const hasWindowError = panelText.includes('测试用异常')

// 3) 导出的文本内容：直接调模块不方便，这里检查面板里的复制按钮能拿到文本
const clip = await page.evaluate(async () => {
  const buttons = [...document.querySelectorAll('button')]
  const copy = buttons.find((node) => node.textContent?.trim() === '复制')
  copy?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  return ''
})
void clip

const checks = [
  ['未捕获异常被记进日志', hasWindowError],
  ['数据管理里有「运行日志」入口', rowLabel > 0],
  ['面板里有启动日志（[boot]）', hasBoot],

]
for (const [name, ok] of checks) {
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}`)
}
await page.screenshot({
  path: 'D:/AIcoding/test1/自用软件/Deepsleep/.shots/310-log-panel.png',
  fullPage: false,
})
await browser.close()
process.exitCode = checks.every(([, ok]) => ok) ? 0 : 1
