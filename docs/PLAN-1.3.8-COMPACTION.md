# 1.3.8：上下文压缩

> **接线状态（1.3.8 发布时更新）**：本文档设计的两处触发点已在 `store.ts` 落地——发送前
> `needsCompaction` 判定后调 `compactSession`，请求溢出时用 `urgent` 压一次再重试（只试一次）。
> 摘要写入 `Session.compaction`，由 `toRequestMessages` 的第 6 个参数注入请求；
> ContextMeter 增加了「压缩中…」与「已压缩」两种状态，环的上限改为按该会话最后一轮模型取。
> 手动压缩按钮本版没做。断言见 `analysis/compaction-138/run.ps1`（14 项）。
目标：会话长到接近模型窗口时不再整段发出去，而是把较早的一段换成一份结构化 checkpoint，近期历史仍逐字保留。
机制照 `@deepseek-ai/dsh-compaction-basic`（本机 `%APPDATA%\npm\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\dsh-compaction-basic`，下文简称 DSH）抄；摘要模型不可用时退回原来的百万上下文策略。

本阶段只做**设计 + 纯逻辑**：`services/chat/compaction.ts` 与 `reply.ts` 的请求装配，不动 UI、不动 i18n、不动 store。
文档里的行号以 1.3.6 树（`deepsleep/frontend/src`，2026-11-13 的 `reply.ts` / 11-16 的 `types.ts`）为准。

## 零、先纠正三处前提

**1. `getContextRounds()` 现在不截断，代码里没有任何 1M 截断。**
`services/chat/reply.ts:287` 只是把「提问 + 有可用回答」配成轮次；`toRequestMessages()`（`reply.ts:303`）把它们全部塞进请求，不做预算裁剪。全库唯一的 1M 是 `components/chatInput/ContextMeter.tsx:8` 的显示常量和 `i18n/zh.ts:54` 的文案「超出后最早的对话会被截断」——**文案描述的行为不存在**。所以「照旧 1M 上限 + 截断」在 1.3.6 树上没有对应实现，本阶段把它作为纯函数补上（`trimRoundsToWindow`），接入留到第二阶段。

影响：今天真超窗口时是服务端返回 400，用户看到报错。压缩的溢出恢复路径因此不是优化，而是第一次让这种情况自愈。

**2. 请求体里没有 `max_tokens`。**
`CreateMessageRequest`（`services/api/types.ts:178`）没有这个字段，store 也从不传。DSH 用 `maxTokens` 给摘要输出封顶并在触顶时判定失败；本 App 只能靠两道事后校验代替：`stop_reason: max_tokens` 视为摘要不完整而失败，以及「摘要必须比它替换掉的原文更短」（DSH 同款：拒绝不缩小源内容的摘要）。

**3. 拿不到模型真实窗口。**
`services/api/client.ts` 只调 `GET /models` 校验 Key，返回体没被解析；`ChatModel` 两个值的窗口都只能从官方价格页推断。窗口、输出预留、图片视觉定价这三项都是猜的，全部集中在 `COMPACTION_POLICY` 与 §八 的清单里，改一个地方就能校准。

## 一、阈值公式

照 DSH `resolveCompactSpec()`：设窗口 `W`、本路由输出预留 `O`、额外余量 `B`，

```
thresholdTokens = floor(min(W × thresholdRatio, W − O − B))     thresholdRatio = 0.8, B = 65536
retainTokens    = floor((W − O) × retainRatio)                  retainRatio    = 0.16
```

`min()` 里两支的含义不同：第一支是「窗口用到 80% 就压」，第二支是「必须给输出和余量留出绝对空间」。小窗口时第二支赢（占比不再有意义），大窗口时第一支赢。

本 App 取值（`COMPACTION_POLICY`）：

| 符号 | 含义 | 取值 | 来源 |
|---|---|---|---|
| `W` | 模型窗口 | 1,000,000 | 猜，见 §八 |
| `O` | 输出预留 | 32,768 | 猜，见 §八 |
| `B` | 额外余量 | 65,536 | 照抄 DSH `headroomTokens` |
| `thresholdRatio` | 触发比例 | 0.8 | 照抄 |
| `retainRatio` | 逐字保留比例 | 0.16 | 照抄 |

代入：

| 量 | 计算 | 结果 |
|---|---|---|
| `W − O` | 1,000,000 − 32,768 | 967,232 |
| 比例支 | 1,000,000 × 0.8 | **800,000** |
| 绝对支 | 967,232 − 65,536 | 901,696 |
| `thresholdTokens` | floor(min(800,000, 901,696)) | **800,000** |
| `retainTokens` | floor(967,232 × 0.16) | **154,757** |

注意 800,000 < 901,696：**在 1M 窗口下比例支永远赢**，所以 `O` 猜错不影响触发点，只影响保留预算（±几千 token）。真正需要 `O` 准确的是小窗口模型，那时绝对支会接管。

「压力」的口径与 `ContextMeter` 完全一致，不另立一套（DSH 的原则是「一个测量服务给所有决策定价」）：

```
pressure = input_tokens + cache_read_input_tokens + cache_creation_input_tokens + output_tokens
```

`message_delta` 里这四个数是整轮累计值，所以会话中最后一条有 `usage` 的回答就代表「现在占多少」。判定为 `pressure >= thresholdTokens`。

压缩后的预期：摘要（目标 ≤ 20k）+ 逐字保留区 154,757 ≈ **175k**，即窗口的 17.5%；下次再涨 62.5 万 token 才触发第二次。这个留白是刻意的——DSH 的 0.8 / 0.16 就是为「压一次顶很久」调的。

## 二、触发点

只有两个，都在**发请求这一侧**，都不改用户可见的状态：

| 触发点 | 位置（第二阶段接入） | 判定 | 失败后 |
|---|---|---|---|
| 发送前 | `store.ts` 的 `streamReply()`：`prepareFiles()` 之后、`toRequestMessages()` 之前（当前 1081 行附近） | 上一轮 `usage` 换算的压力 ≥ 阈值 | 记一条日志，照常发全量 |
| 溢出错误后 | `streamReply()` 的 `catch`（当前 1156 行附近） | `isContextOverflowError(error)` 为真，且重试次数 < 1 | 报原来的错 |

发送前那次用 `needsCompaction(rounds, session.compaction, W)` 判定，不用裸的 `shouldCompact()`：刚压完时最后一条回答的 `usage` 还是压缩前的旧数字（80 万），直接比会立刻再压一次。`needsCompaction` 用 `compaction.createdAt` 把「检查点之前的用量」排除掉。

溢出那次**绕过阈值与保留预算**（`urgent: true`）：`retainTokens = 0`，只留最新一轮逐字，把其余全部压掉——对应 DSH 的「一次最大平衡头部缩减」。重试上限 `maxOverflowRetries = 1`，与 DSH 默认一致。

手动压缩（ContextMeter 上的按钮）是第三阶段的事，走同一个 `compactSession()`，只是不经阈值。

## 三、保留区怎么切

DSH 的 `selectCompactableRange()` 从最新一条往前累加，累到 `retainTokens` 为止，前面那一段才是可压范围；并且不切断工具调用/结果对。

本 App 对应的不变量是**不切轮次**：`[UserMessage, AssistantMessage]` 是原子单位（`getContextRounds` 就是这样配对的），切在中间会让请求里出现孤立的提问或回答。所以：

1. **至少保留最新一轮**：`retainTokens = 0`（溢出恢复）时正好只剩它；最后一轮自己就吃满保留预算时也只留它。
2. 累加从最新一轮往前，跨过 `retainTokens` 的那一轮整轮留在保留区（宁可多留）。
3. 会话只有 1 轮时返回 `null`，不发摘要请求——这是「没有可安全压缩的内容」，DSH 同样不动任何东西。

图片是这套估算唯一的黑洞：附件走 `file_id`，视觉 token 由服务端算，本 App 拿不到。`estimateRoundTokens()` 只按文件块记一个固定结构开销（16 token/块），**含图会话的估算严重偏低**。后果是保留区可能切得偏大、溢出判定偏晚；溢出恢复路径兜住这种情况。真实修复要等 `usage` 里出现图片定价，或改用逐轮 `usage` 增量。

## 四、摘要请求长什么样

DSH 的关键设计不是提示词，而是**把摘要调用做成会话请求的真前缀**：同一个 system、同一份工具声明、同样的历史消息，只把压缩指令作为**最后一条 user 消息**追加。这样 provider 的 KV 前缀缓存能命中到指令之前，只有指令和摘要输出是冷的。

本 App 的等价请求（`buildCompactionRequest`）：

```
system:  与主请求同一个 SYSTEM_PROMPT
messages: [ 上一代 checkpoint（如果有，user 角色） ]
          [ 被压缩区间的消息，原样回放：latest_reminder / user / assistant ... ]
          { role: 'user', content: COMPACTION_INSTRUCTION }   ← 最后一条
tools / safety_check / thinking / output_config: 与主请求同形
title:   不带（不能给摘要调用顺带生成标题）
```

四件事按 DSH 原样搬：

- **指令是最后一条 user 消息，不是单独的 system**。放进 system 会让前缀与主请求分叉，缓存全废。
- **复用 `toRequestMessages()` 组装**，不自己拼消息。收益是转换规则（历史思考不回传、`read_link` 保留签名、空提问跳过、`latest_reminder` 快照）与真实请求逐字一致；这也是缓存能命中的前提。
- **上一代 checkpoint 排在最前**。第二次压缩时，旧摘要是被替换掉的内容，不带上就会丢掉它记着的一切。指令里已经写了「如果已有 `<compacted-summary>` 块，那是上一代，合并而不是照抄」。
- **只取 text 块**。思考和工具调用不进 checkpoint；`stop_reason: max_tokens` 视为摘要被截断，整体失败。

指令原文（`COMPACTION_INSTRUCTION`，8 小节结构与 DSH 的 `COMPACTION_INSTRUCTION` 一一对应，标题译成中文、规则逐条保留；英文原标题列在 `compaction.ts` 该常量的注释里）：

```
## 主要请求与意图 / 关键技术概念 / 文件与代码 / 错误与修复
## 未完成的工作 / 当前进度 / 下一步 / 关键上下文
```

摘要在落盘时存**原文**，包装在请求侧生成：

```
<前导：这是一份自动生成的 checkpoint …… 不要复述它，不要对它作任何回应。>

<compacted-summary>
## 主要请求与意图
...
</compacted-summary>
```

前导（`CHECKPOINT_PREAMBLE`）是 DSH 原文的中文版：把 checkpoint 当作既定背景、在后面的消息上继续、不要回应它。包装函数 `frameCheckpoint()` 放在 `reply.ts`——它决定的是「检查点以什么形状进入请求」，属于请求装配；`compaction.ts` 反向导入它来算 `savedTokens`，依赖方向只有一条，没有循环。

## 五、落盘形态

`types.ts` 的 `Session` 加一个可选字段：

```ts
compaction?: {
  summary: string        // 模型返回的 checkpoint 原文，不含前导与标签
  upToMessageId: string  // 被摘要的最后一轮回答 id，决定逐字保留区的起点
  createdAt: number      // 生成时间；也用来屏蔽压缩前的旧 usage
  savedTokens: number    // 估算释放的 token 数，仅用于展示
}
```

- 可选字段，老数据不迁移：`db.ts` 的 `saveSession()` 直接 `put(session)`，IndexedDB 走结构化克隆，新字段自然带上，不需要 `DB_VERSION` 递增。
- 存原文不存包装：UI（第二阶段）要展示干净的摘要，包装只属于请求。
- 会话内只有**一份** checkpoint：新一代覆盖旧一代，旧内容已经并进新摘要（见 §四）。
- **导出/导入会丢**：`history/toArchive.ts` 与 `toLocal.ts` 显式挑字段重建 `Session`，`compaction` 不在其中。本阶段不动 `history/*`，先记在账上——导出的归档少了 checkpoint 只会导致重新压缩一次，不影响正确性。

## 六、失败与回退

`compactSession()` 只在成功时返回，其余一律抛 `CompactionError`（带 `reason`），由调用方决定回退：

| `reason` | 触发条件 | 调用方动作 |
|---|---|---|
| `no-api-key` | `apiKey` 为空 | 退回百万策略 |
| `empty-range` | 没有可安全压缩的范围 | 不压，照常发 |
| `empty-summary` | 模型返回空文本 | 退回 |
| `truncated` | `stop_reason: max_tokens` | 退回 |
| `not-shrinking` | 摘要不比原文短 | 退回（DSH 同款拒绝） |
| `request` | 网络/HTTP/流错误 | 退回；若 `signal.aborted` 则原样抛，按取消处理 |

**百万上下文策略**= 压缩没成功时什么都不改：请求照常按 1M 上限发；真超窗口就命中溢出错误，报给用户。`trimRoundsToWindow()` 提供这个策略的裁剪实现（从最早一轮开始丢到 `W − O` 以内），但是**默认不接**——静默丢历史比报错更难排查，是否默认开启由第二阶段拍板。

不回退、也不该被回退的情况：用户点停止（`AbortError` 原样抛出）。压缩中的取消不能写 `session.compaction`，否则会话会顶着一份半截的摘要。

## 七、与 1M 截断的关系

四个状态，别混：

| 状态 | 请求里有什么 | 触发条件 |
|---|---|---|
| 无 checkpoint，未超阈值 | 全部轮次 | 常态 |
| 有 checkpoint | 1 条摘要 + 保留区轮次 | 压缩成功 |
| 有 checkpoint，但锚点不在当前分支 | 全部轮次（摘要被忽略） | 切版本/分叉后 |
| 无 checkpoint，压缩失败 | 全部轮次 | 回退 |

第三条要点：`toRequestMessages()` 按 `upToMessageId` 在**当前分支**上找锚点，找不到就整份摘要不用。把另一条分支的摘要混进请求，比丢掉摘要更糟。代价是切版本后要重压一次——第二阶段应该在 `selectVersion` / `editMessage` 时清掉 `session.compaction`（`store.ts`，本阶段不动）。

`trimRoundsToWindow()` 与压缩是互斥的两条路，不叠加：要么摘要顶替旧区间，要么旧区间被裁掉。同时用会让摘要描述的内容和实际发出去的消息对不上。

## 八、猜的东西

全部集中在 `COMPACTION_POLICY` / `MODEL_CONTEXT_WINDOWS` / `isContextOverflowError` 三处，校准只改这三处。

| 项 | 取值 | 依据 | 错了会怎样 |
|---|---|---|---|
| `W`（deepseek-flash） | 1,000,000 | `ContextMeter.tsx:8` 的常量与官方价格页的 1M | 偏大 → 压得太晚、真溢出；偏小 → 压得过勤、多花摘要费用 |
| `W`（deepseek-v4-pro） | 1,000,000 | 无依据，按同系列推 | 同上 |
| `O` | 32,768 | 请求不传 `max_tokens`，服务端默认输出上限未知 | 1M 下不影响触发点（见 §一），只影响保留预算 ±几千 |
| 图片 token | 16/块 | 拿不到视觉定价 | 含图会话估算偏低，保留区切得偏大 |
| `token/字符` | 0.75 | 与 `ContextMeter.tsx:67` 同口径；DSH 的 4 字符/token 对中文明显偏低（DSH README 自己承认） | 直接缩放保留预算 |
| 溢出报错识别 | 关键词匹配 | **未对照真实报文**；DSH 靠适配器把错误规范化成 `CONTEXT_WINDOW_EXCEEDED`，本 App 只有 `ApiError.message` | 漏判 → 不重试，报错给用户；误判 → 白压一次 |
| 相邻 user 消息 | 不合并 | DeepSeek 原生接口会合并连续同角色消息，兼容层未实测 | 若被拒，摘要后接第一条保留轮次会 400 |

能拿到的、就不该猜的（第二阶段的活）：`GET /models` 的响应体里若有 `context_length`，直接在那里解析；`usage` 若带图片定价，替换 `estimateRoundTokens()`。

## 九、本阶段的改动与验收

| 文件 | 改动 |
|---|---|
| `docs/PLAN-1.3.8-COMPACTION.md` | 本文档 |
| `services/chat/types.ts` | 新增 `SessionCompaction` 类型与 `Session.compaction?` |
| `services/chat/reply.ts` | 新增 `CHECKPOINT_PREAMBLE` / 标签常量 / `frameCheckpoint()`；`toRequestMessages()` 加第 6 个可选参数 `compaction`，摘要作为第一条消息放在 system 之后、保留区之前 |
| `services/chat/compaction.ts` | 新建：阈值、估算、范围选择、请求构造、一次摘要调用、溢出识别、百万回退 |
| `../../analysis/compaction-138/`（工作区根目录下，不属于 App 源码） | 纯逻辑的验证脚本（`run.ps1` + `check.mjs` + `client.stub.js`），14 项断言，可重复跑 |

不碰：`SettingsDialog.tsx`、`db.ts`、`store.ts`、`i18n/*`、`history/*`、`backup.ts`、`android/`。

验收分两层：

- `pnpm type`（`frontend/`）退出码 0。开工时基线其实不绿——`SettingsDialog.tsx` 有 4 个错（`ATTACHMENT_SIZE_LIMIT_MB` 未导出、`includeAttachments` / `toggleAttachments` 不存在），来自另一位队友当时正在改的 `backup.ts`；他那半边落地后整棵树是干净的。
- 纯逻辑：在工作区根目录 `<repo>` 下跑 `powershell -ExecutionPolicy Bypass -File analysis\compaction-138\run.ps1`，输出 `OK 14 checks`。做法是把 `compaction.ts` 的模块图编译到临时目录、把 `services/api/client.js` 换成桩（真实文件依赖构建期常量 `__API_ORIGIN__` 与网络），然后断言阈值、保留预算、`shouldCompact` 边界、`needsCompaction` 屏蔽旧 usage、范围选择不切轮次、摘要请求的形状（指令在最后、上一代 checkpoint 在最前、不带 `title`）、`toRequestMessages` 的摘要顶替与锚点失效、`compactSession` 的成功与六类失败、取消不包装、溢出识别、百万回退裁剪。

这套脚本第一次跑就抓到 `selectCompactionRange` 的真 bug：`retainTokens = 0` 时循环条件一开始就为假，`index` 停在末尾，等于把**全部**轮次都压掉、不留逐字尾部。修法是先无条件把最新一轮计入保留（`index = rounds.length - 1` 之后累加），与 DSH 逐行对齐。

