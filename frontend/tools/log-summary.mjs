// 定向故障测试：导入失败写进日志的只有可信翻译错误码，不落任意 message。
//
// 用法（frontend 下）：
//   node --experimental-transform-types --import ./tools/run-ts.mjs tools/log-summary.mjs
//
// 背景：BackupError 把翻译键（backupIncomplete 等）当 message 抛出，而 errorSummary()
// 只保留 /^[A-Z_]{3,}$/ 的纯大写错误码，导入失败的四种原因在日志里全糊成一条 "BackupError"。
// 断言：白名单内的键原样保留；白名单外的任何字符串（可能被伪造、也可能是用户内容）都不进日志。
import assert from 'node:assert/strict'

const storage = new Map()
globalThis.localStorage = {
  getItem: (key) => storage.get(key) ?? null,
  setItem: (key, value) => storage.set(key, String(value)),
  removeItem: (key) => storage.delete(key),
}
globalThis.window = globalThis

const { BackupError, BACKUP_ERROR_KEYS, isBackupErrorKey } =
  await import('../src/services/chat/history/errors.ts')
const { clearLog, errorSummary, getLogEntries, logError } = await import('../src/services/log.ts')

// ---- 1. 白名单内的键：类型名 + 键，能区分导入失败的四种原因 ---------------------
for (const key of BACKUP_ERROR_KEYS) {
  assert.equal(isBackupErrorKey(key), true)
  assert.equal(errorSummary(new BackupError(key)), `BackupError:${key}`)
}
const seen = new Set(
  ['backupInvalidJson', 'backupUnrecognized', 'backupNewerVersion', 'backupIncomplete'].map((key) =>
    errorSummary(new BackupError(key))
  )
)
assert.equal(seen.size, 4, '四种导入失败原因在日志里必须能区分')
console.log(`PASS 1 白名单 ${BACKUP_ERROR_KEYS.length} 个键全部原样保留，四种失败原因各不相同`)

// ---- 2. 白名单外的键：只留类型名，绝不落原文 -----------------------------------
{
  const forged = new BackupError('backupIncomplete')
  // readonly 只在类型层；运行时能改，模拟「被塞进任意字符串」的情况
  forged.key = 'sk-用户的真实内容-不该出现在日志里'
  assert.equal(isBackupErrorKey(forged.key), false)
  assert.equal(errorSummary(forged), 'BackupError')
  console.log('PASS 2 伪造的 key：只剩 "BackupError"，不暴露任意 message')
}

// ---- 3. 走真实落盘路径（backup.ts 的 logError('import', …, errorSummary(error))）------
{
  clearLog()
  logError('import', '导入失败', errorSummary(new BackupError('backupNewerVersion')))
  logError('import', '导入失败', errorSummary(new BackupError('backupInvalidJson')))
  const forged = new BackupError('backupIncomplete')
  forged.key = 'sk-用户的真实内容-不该出现在日志里'
  logError('import', '导入失败', errorSummary(forged))
  const lines = getLogEntries().map((entry) => entry.message)
  assert.ok(
    lines.some((line) => line.includes('BackupError:backupNewerVersion')),
    lines.join('\n')
  )
  assert.ok(
    lines.some((line) => line.includes('BackupError:backupInvalidJson')),
    lines.join('\n')
  )
  assert.ok(!lines.some((line) => line.includes('不该出现在日志里')), '日志里出现了不受控文本')
  console.log(`PASS 3 落盘三条：${lines.join(' / ')}`)
}

// ---- 4. 原有规则不变：普通 Error 仍只留大写错误码 ------------------------------
{
  assert.equal(errorSummary(new Error('NOPE_SPACE_EXCEEDED')), 'Error:NOPE_SPACE_EXCEEDED')
  assert.equal(errorSummary(new TypeError('r.at is not a function')), 'TypeError')
  assert.equal(errorSummary('backupIncomplete'), 'string')
  assert.equal(errorSummary(null), 'object')
  console.log('PASS 4 普通 Error 摘要规则未变（大写码保留、调用现场去掉）')
}

console.log('全部通过：导入失败只记可信翻译错误码')
