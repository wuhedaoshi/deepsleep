// 开发服务器：`NODE_ENV=development rspack serve` 在 Windows 的 cmd 里跑不了，
// 这里设好环境变量再转手给 rspack，跨平台一致。
import { spawn } from 'node:child_process'

const child = spawn('rspack', ['serve', '-c', 'rspack.config.ts'], {
  stdio: 'inherit',
  shell: true,
  env: { ...process.env, NODE_ENV: 'development' },
})
child.on('exit', (code) => process.exit(code ?? 0))
