// 回归验证：历史里带一张 webp（服务端不认）时，发送不应该永久失败。
//
// 流程：正常发一条消息 → 把首轮提问改造成「带 webp 附件且已有 serverId」→
// 再发一条 → mock 第一次回 400 unsupported image → 客户端应当把可疑图片的
// serverId 清掉并重试，重试请求里不再有 image 块，最终回复状态是 done。
//
// 用法（frontend 下，先按 MOCK_FAIL_UNSUPPORTED_IMAGE=1 启动 mock）：
//   node --experimental-transform-types --import ./tools/run-ts.mjs tools/unsupported-image-e2e.mjs
globalThis.__API_ORIGIN__ = 'http://127.0.0.1:8099'
const memoryStore = new Map()
globalThis.localStorage = {
  getItem: (key) => (memoryStore.has(key) ? memoryStore.get(key) : null),
  setItem: (key, value) => memoryStore.set(key, String(value)),
  removeItem: (key) => memoryStore.delete(key),
  clear: () => memoryStore.clear(),
}
globalThis.requestAnimationFrame = (callback) => setTimeout(() => callback(0), 0)
globalThis.cancelAnimationFrame = (id) => clearTimeout(id)
globalThis.document = { visibilityState: 'visible', addEventListener() {}, removeEventListener() {} }
globalThis.window = globalThis

import 'fake-indexeddb/auto'
import { readFileSync } from 'node:fs'

const db = await import('../src/services/chat/db.ts')
const { initChat, sendMessage, useChatStore } = await import('../src/services/chat/store.ts')
const { setDraftText } = await import('../src/services/chat/drafts.ts')
const { useSettings } = await import('../src/services/settings.ts')

useSettings.setState({ apiKey: 'sk-mock', model: 'deepseek-flash' })
await initChat()

const waitIdle = async (sessionId) => {
  for (let i = 0; i < 400; i += 1) {
    if (useChatStore.getState().streaming[sessionId] === undefined) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error('发送没有在 20s 内结束')
}

// 1) 第一轮：建立会话
setDraftText(null, '第一轮')
sendMessage(null)
const sessionId = useChatStore.getState().activeId
await waitIdle(sessionId)

// 2) 给首轮提问塞一张「服务端不认的 webp」，并假装它已经有 serverId（历史遗留状态）
const stored = await db.loadSession(sessionId)
const user = stored.messages.find((message) => message.role === 'user')
user.files.push({
  id: 'file-webp',
  serverId: 'file_bad_webp',
  name: '来自微信的截图.webp',
  size: 12_000,
  isImage: true,
  mimeType: 'image/webp',
})
await db.saveSession(stored)
useChatStore.setState((state) => ({
  sessionCache: { ...state.sessionCache, [sessionId]: stored },
}))

// 3) 再发一条：第一次会撞 400，客户端应清掉坏图重试
setDraftText(sessionId, '第二轮')
sendMessage(sessionId)
await waitIdle(sessionId)

const records = readFileSync(process.env.MOCK_LOG ?? 'requests.jsonl', 'utf8')
  .trim()
  .split('\n')
  .map((line) => JSON.parse(line))
const after = await db.loadSession(sessionId)
const attachment = after.messages.find((m) => m.role === 'user')?.files.find((f) => f.id === 'file-webp')
const lastReply = [...after.messages].reverse().find((m) => m.role === 'assistant')

const checks = [
  ['共 3 次请求（首轮 + 撞错 + 重试）', records.length === 3],
  ['第一次带 1 个 image 块', records[1]?.imageBlocks === 1],
  ['重试请求里没有 image 块', records[2]?.imageBlocks === 0],
  ['可疑图片的 serverId 已清空', attachment?.serverId === null],
  ['最终回复是 done（不是 error）', lastReply?.status === 'done'],
  ['本地原件仍保留在消息里', attachment !== undefined],
]
for (const [name, ok] of checks) {
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}`)
}
console.log(`请求序列：${records.map((r) => `${r.kind}(${r.imageBlocks} img)`).join(' → ')}`)
process.exitCode = checks.every(([, ok]) => ok) ? 0 : 1
