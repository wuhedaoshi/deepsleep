# 和本机 Codex 协作的协议

这份文件是 DSH（下面叫 **Lead**）与本机 Codex CLI 之间的约定。谁先开工都先读它。

## 角色

| 角色 | 是谁 | 职责 |
|---|---|---|
| **Lead** | DSH 会话（我） | 定方案、拆任务、合并、跑验收、维护主线 |
| **Codex** | 本机 `codex` CLI（`codex-cli 0.163.0`） | 独立实现、独立复核，不碰主线 |

## 一次交接的形状

1. Lead 写任务到 `handoff/TASK.md`（范围、验收标准、禁止事项），必要时直接调 `codex exec` 把任务抛过去。
2. Codex 在自己的分支上做：`codex/<topic>`。**不要直接改 `main` / `release-1.2`。**
3. Codex 完成后把结论写进 `handoff/REPLY.md`：改了什么、怎么验的、还剩什么没做。
4. Lead 读 `REPLY.md`、跑验收、合并或退回。

## 硬规则

- **写作用域不重叠**：一次只允许一方改同一批文件。Lead 在任务里点名文件或目录，Codex 不要越界。
- **不推送、不改历史**：不给远端 push，不 `reset --hard`、不 `rebase` 别人的提交。
- **先自检再交付**：`pnpm type`、`pnpm lint` 必须全绿；改到 Android 侧时 `:app:compileReleaseJavaWithJavac` 要过。
- **不碰的东西**：`keystore/`、`local.properties`、`android/version.properties`（版本号由 Lead 统一管）、`release/`。
- **产物放对地方**：临时文件放 `.work/`（已 gitignore），不要塞进仓库根。

## 通信通道

| 通道 | 用途 |
|---|---|
| `handoff/TASK.md` / `handoff/REPLY.md` | 人类可读的任务与回执，随仓库走 |
| `handoff/runs/*.md` | 每次 `codex exec` 的完整记录（提示词 + 输出 + 退出码），已 gitignore |
| `git log` / `git diff` | 事实来源。文字说明与代码不一致时以代码为准 |

## 常用命令

```bash
# Lead 把活派给 Codex（一次性，非交互）
node tools/agent-bridge.mjs ask "读 handoff/TASK.md，在 codex/<topic> 分支上实现第 1 节"

# Codex 独立复核当前未提交改动
node tools/agent-bridge.mjs review --uncommitted

# 看最近几次交接
node tools/agent-bridge.mjs status
```
