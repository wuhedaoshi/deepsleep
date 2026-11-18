#!/usr/bin/env node
/**
 * 本机 Codex CLI 的桥。
 *
 * 为什么需要它：DSH 没有 MCP 客户端（223 个插件里没有任何 mcp 相关），所以两边
 * 没法用 MCP 对接；但本机 `codex` 支持非交互执行，这就是最直接的通道——
 * 由这里 spawn 一次 `codex exec`，把提示词交过去，收回输出并存档。
 *
 * 用法：
 *   node tools/agent-bridge.mjs ask "<任务>"            # 一次性委派
 *   node tools/agent-bridge.mjs ask -f handoff/TASK.md  # 从文件读任务
 *   node tools/agent-bridge.mjs review --uncommitted    # 让 Codex 复核未提交改动
 *   node tools/agent-bridge.mjs status                  # 看最近几次记录
 *
 * 约定见 handoff/PROTOCOL.md。
 */
import { spawn } from 'node:child_process'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const runsDir = path.join(root, 'handoff', 'runs')

/** codex 找不到时给一句能照做的提示，而不是一串 ENOENT */
const CODEX_HINT = `找不到 codex 命令。确认它已安装并加入 PATH，例如：
  $env:PATH = "D:\\Codex\\npm-global;$env:PATH"
  codex --version   # codex-cli 0.163.0`

const stamp = () => {
  const d = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
}

/** 跑一次 codex，边跑边把输出打到终端，最后返回 { code, output } */
const runCodex = (args, input) =>
  new Promise((resolve, reject) => {
    const child = spawn('codex', args, {
      cwd: root,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
      env: process.env,
    })
    let output = ''
    const collect = (chunk) => {
      const text = chunk.toString()
      output += text
      process.stdout.write(text)
    }
    child.stdout.on('data', collect)
    child.stderr.on('data', collect)
    child.on('error', (error) => {
      reject(error.code === 'ENOENT' ? new Error(CODEX_HINT) : error)
    })
    child.on('close', (code) => resolve({ code, output }))
    if (input !== undefined) {
      child.stdin.end(input)
    } else {
      child.stdin.end()
    }
  })

const saveRun = async (kind, prompt, code, output) => {
  await mkdir(runsDir, { recursive: true })
  const file = path.join(runsDir, `${stamp()}-${kind}.md`)
  await writeFile(
    file,
    [
      `# ${kind} · ${new Date().toISOString()}`,
      '',
      '## 提示词',
      '',
      '```text',
      prompt.trim(),
      '```',
      '',
      '## 输出',
      '',
      '```text',
      output.trim() || '(空)',
      '```',
      '',
      `退出码：${code}`,
      '',
    ].join('\n'),
    'utf8'
  )
  return file
}

const readPrompt = async (args) => {
  const fileIndex = args.findIndex((arg) => arg === '-f' || arg === '--file')
  if (fileIndex >= 0) {
    const target = args[fileIndex + 1]
    if (!target) {
      throw new Error('-f 后面要跟文件路径')
    }
    return readFile(path.resolve(root, target), 'utf8')
  }
  const inline = args.join(' ').trim()
  if (inline === '') {
    throw new Error('给一句话任务，或用 -f <文件>')
  }
  return inline
}

/** 让 Codex 知道自己在和谁协作、边界在哪 */
const PREFIX = `你在与 DSH 会话协作开发这个仓库。先读 handoff/PROTOCOL.md 并遵守它：
不要直接改 main / release-1.2，不要 push，不要碰 keystore、local.properties、android/version.properties。
完成后用简短中文汇报：改了什么、怎么验证的、还剩什么。任务如下：

`

const main = async () => {
  const [command, ...rest] = process.argv.slice(2)
  try {
    if (command === 'ask') {
      const prompt = PREFIX + (await readPrompt(rest))
      const { code, output } = await runCodex(
        ['exec', '--skip-git-repo-check', '-C', root, '-'],
        prompt
      )
      const file = await saveRun('ask', prompt, code, output)
      console.log(`\n[bridge] 记录已存 ${path.relative(root, file)}`)
      process.exitCode = code === 0 ? 0 : 1
      return
    }

    if (command === 'review') {
      const extra = rest.length === 0 ? ['--uncommitted'] : rest
      const { code, output } = await runCodex(
        ['exec', 'review', ...extra, '-C', root].filter(Boolean),
        '用中文给出发现的问题，按严重程度排序，指出具体文件与行为。'
      )
      const file = await saveRun('review', `codex exec review ${extra.join(' ')}`, code, output)
      console.log(`\n[bridge] 记录已存 ${path.relative(root, file)}`)
      process.exitCode = code === 0 ? 0 : 1
      return
    }

    if (command === 'status') {
      if (!existsSync(runsDir)) {
        console.log('还没有交接记录。')
        return
      }
      const files = (await readdir(runsDir)).filter((name) => name.endsWith('.md')).sort()
      for (const name of files.slice(-8)) {
        const body = await readFile(path.join(runsDir, name), 'utf8')
        const tail = body.split('## 输出')[1]?.split('\n').filter(Boolean).slice(1, 3).join(' ') ?? ''
        console.log(`${name}  ${tail.slice(0, 90)}`)
      }
      return
    }

    console.log(`用法：
  node tools/agent-bridge.mjs ask "<任务>" | -f handoff/TASK.md
  node tools/agent-bridge.mjs review [--uncommitted]
  node tools/agent-bridge.mjs status`)
  } catch (error) {
    console.error(`[bridge] ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}

await main()
