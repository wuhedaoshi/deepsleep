import { logInfo } from '../log.js'
/**
 * 上下文压缩：会话接近模型窗口时，把较早的若干轮换成一份结构化 checkpoint，近期轮次仍逐字发送。
 *
 * 机制照 @deepseek-ai/dsh-compaction-basic：
 * - 触发阈值 floor(min(W × 0.8, W − O − B))、逐字保留 (W − O) × 0.16，比例照抄默认值；
 * - 摘要调用是主请求的真前缀（同 system、同工具、原样回放历史），压缩指令作为**最后一条 user**
 *   消息追加，provider 的前缀缓存因此能命中到指令之前；
 * - 摘要包在 <compacted-summary> 里，前面是一段「这是自动生成的 checkpoint」前导（见 reply.ts）；
 * - 摘要必须比它替换掉的原文更短，否则整体失败。
 *
 * 这里全是纯函数加一次模型调用：不碰 React、不碰 i18n、不碰 zustand。失败一律抛 CompactionError，
 * 要不要回退、怎么回退由调用方决定（见 docs/PLAN-1.3.8-COMPACTION.md）。
 */
import { streamMessage } from '../api/client.js'
import type { ChatModel, CreateMessageRequest, MessageUsage } from '../api/types.js'
import { getVisibleMessages } from './branches.js'
import { frameCheckpoint, getContextRounds, getReplyText, toRequestMessages } from './reply.js'
import type {
  AssistantMessage,
  Message,
  Session,
  SessionCompaction,
  UserMessage,
} from './types.js'

// ---------- 阈值政策 ----------

/** 一轮对话：提问与它的可用回答。压缩的最小单位，永不切开。 */
export type Round = [UserMessage, AssistantMessage]

/**
 * 压缩政策。W = window，O = outputReserve，B = headroom，与 DSH 的
 * thresholdRatio / headroomTokens / retainRatio 一一对应。
 */
export type CompactionPolicy = {
  /** W：模型上下文窗口 */
  window: number
  /** O：本路由为输出预留的 token */
  outputReserve: number
  /** B：阈值之外再留的余量 */
  headroom: number
  /** 触发阈值占窗口的比例 */
  thresholdRatio: number
  /** 逐字保留的近期历史占 W − O 的比例 */
  retainRatio: number
}

/**
 * 默认政策。比例与余量照抄 DSH；窗口与输出预留是猜的（文档 §八）：
 * 接口只用来校验 Key，返回体没解析，两个模型的真实窗口与默认输出上限都查不到。
 * W = 1M 时 min() 的比例支（800,000）恒小于绝对支（901,696），所以 O 猜错不影响触发点。
 */

/**
 * 文本估算说「全都要保留」时，仍然保留的最近轮次数。
 *
 * 为什么需要它：触发判定用真实 usage，而「能压多少」用字符估算。图片/附件占大头的会话里
 * 两者会背离——usage 说该压了，估算说全都得保留，结果压缩永远压不动。
 */
const FALLBACK_KEEP_ROUNDS = 2

/** 摘要掉一个带附件的轮次时，至少释放的 token 数（保守下限，只用于「是否变小」判定） */
const ATTACHMENT_FLOOR_TOKENS = 1024

export const COMPACTION_POLICY: CompactionPolicy = {
  window: 1_048_576,
  outputReserve: 32_768,
  headroom: 65_536,
  thresholdRatio: 0.8,
  retainRatio: 0.16,
}

/** 模型默认窗口；判定、摘要保留预算与仪表必须共用同一来源。 */
export const MODEL_CONTEXT_WINDOWS: Record<ChatModel, number> = {
  'deepseek-flash': 1_048_576,
  'deepseek-v4-pro': 1_048_576,
}

export const contextWindowFor = (model: ChatModel): number => MODEL_CONTEXT_WINDOWS[model]

export const resolveWindow = (model: ChatModel, override: number | null): number => {
  const known = contextWindowFor(model)
  if (override !== null && Number.isFinite(override) &&
      override > COMPACTION_POLICY.outputReserve + COMPACTION_POLICY.headroom) {
    return known ? Math.min(known, override) : override
  }
  return known
}

export const outputCapFor = (window: number): number =>
  Math.max(1, Math.min(COMPACTION_POLICY.outputReserve, Math.floor(window / 4)))

export const policyFor = (window: number, outputCap?: number): CompactionPolicy => ({
  ...COMPACTION_POLICY,
  window,
  outputReserve: outputCap ?? Math.min(COMPACTION_POLICY.outputReserve, Math.floor(window / 4)),
  headroom: Math.min(COMPACTION_POLICY.headroom, Math.floor(window / 4)),
})

/** 压力口径与 ContextMeter 一致：message_delta 里这四个数是整轮累计值。 */
export const getPressureTokens = (usage: MessageUsage | undefined): number =>
  usage === undefined
    ? 0
    : usage.input_tokens +
      usage.cache_read_input_tokens +
      usage.cache_creation_input_tokens +
      usage.output_tokens

/** floor(min(W × thresholdRatio, W − O − B)) */
export const getThresholdTokens = (
  window: number,
  policy: CompactionPolicy = COMPACTION_POLICY
): number =>
  Math.floor(
    Math.min(window * policy.thresholdRatio, window - policy.outputReserve - policy.headroom)
  )

/** floor((W − O) × retainRatio) */
export const getRetainTokens = (
  window: number,
  policy: CompactionPolicy = COMPACTION_POLICY
): number => Math.floor((window - policy.outputReserve) * policy.retainRatio)

export const shouldCompact = (
  usage: MessageUsage | undefined,
  window: number,
  policy: CompactionPolicy = COMPACTION_POLICY
): boolean => getPressureTokens(usage) > getThresholdTokens(window, policy)

export type CompactionEvaluation = {
  pressure: number
  threshold: number
  source: 'usage' | 'estimate'
  triggered: boolean
  reason:
    | 'above-threshold'
    | 'below-threshold'
    | 'no-usage-and-no-estimate'
    | 'already-compacted'
    | 'nothing-to-compact'
}

/** 与请求装配的锚点规则一致，避免切分支后沿用别的分支的摘要或重复计算已摘要历史。 */
const getCompactionContext = (rounds: Round[], compaction: SessionCompaction | undefined) => {
  const index = compaction === undefined
    ? -1
    : rounds.findIndex(([, reply]) => reply.id === compaction.upToMessageId)
  return index < 0
    ? { rounds, previous: undefined }
    : { rounds: rounds.slice(index + 1), previous: compaction }
}

/**
 * 检查点之前那几轮的 usage 是压缩前的旧数字，用它判定会刚压完立刻再压一次。
 * 新检查点按轮次屏蔽，避免设备时钟回拨；旧存档缺少轮次标记时仍按 createdAt 排除。
 * 导入历史没有 usage，必须按实际会发送的摘要与保留轮次估算，否则永远无法自动压缩。
 */
export const evaluateCompaction = (
  rounds: Round[],
  compaction: SessionCompaction | undefined,
  window: number,
  policy: CompactionPolicy = COMPACTION_POLICY,
  incomingTokens = 0,
  useUsage = true,
  envelopeTokens?: number
): CompactionEvaluation => {
  const last = rounds.at(-1)
  const context = getCompactionContext(rounds, compaction)
  const usagePressure = getPressureTokens(last?.[1].usage)
  const checkpointAfterUsage = context.previous && last && (
    context.previous.lastRoundId ? context.previous.lastRoundId === last[1].id
      : last[1].createdAt <= context.previous.createdAt
  )
  const surface = (envelopeTokens ?? 0) + estimateRoundsTokens(context.rounds) +
    (context.previous === undefined ? 0 : estimateTextTokens(frameCheckpoint(context.previous.summary)))
  const source = useUsage && !checkpointAfterUsage && Number.isFinite(usagePressure) &&
    usagePressure > 0 && (envelopeTokens === undefined || usagePressure >= surface) ? 'usage' : 'estimate'
  const pressure = (source === 'usage' ? usagePressure : surface) + incomingTokens
  const result = { pressure, threshold: getThresholdTokens(window, policy), source } as const
  const previous = context.previous
  if (incomingTokens === 0 && last !== undefined && previous !== undefined && (
    previous.lastRoundId === undefined
      ? last[1].createdAt <= previous.createdAt
      : last[1].id === previous.lastRoundId
  )) {
    return { ...result, triggered: false, reason: 'already-compacted' }
  }
  if (pressure <= 0) {
    return { ...result, triggered: false, reason: 'no-usage-and-no-estimate' }
  }
  if (selectCompactionRange(context.rounds, getRetainTokens(window, policy)) === null) {
    return { ...result, triggered: false, reason: 'nothing-to-compact' }
  }
  if (pressure <= result.threshold) {
    return { ...result, triggered: false, reason: 'below-threshold' }
  }
  return { ...result, triggered: true, reason: 'above-threshold' }
}

/** Measure the request using the same history and route checks in the composer and sender. */
export const evaluateRequestContext = (
  rounds: Round[],
  compaction: SessionCompaction | undefined,
  policy: CompactionPolicy,
  route: { model: ChatModel; system: string; thinking: boolean; search: boolean },
  question: string,
  reminder?: string
): CompactionEvaluation => {
  const previous = rounds.at(-1)?.[1]
  const sameRoute = previous?.model === route.model &&
    previous?.thinking === route.thinking && previous?.search === route.search
  return evaluateCompaction(
    rounds, compaction, policy.window, policy, estimateTextTokens(question), sameRoute,
    estimateTextTokens(route.system) + estimateTextTokens(reminder ?? '')
  )
}

// ---------- token 估算 ----------

/** 中文为主的会话按 0.75 token/字符估，与 ContextMeter 同口径（DSH 的 4 字符/token 对中文明显偏低）。 */
const TOKENS_PER_CHAR = 0.75
/** 角色与消息结构的固定开销，同 DSH estimate.ts 的思路。 */
const MESSAGE_OVERHEAD = 4
/** 附件按 file_id 引用，视觉 token 由服务端定价、本 App 拿不到，只记结构开销。 */
const FILE_BLOCK_OVERHEAD = 16

export const estimateTextTokens = (text: string): number =>
  text.length === 0 ? 0 : Math.ceil(text.length * TOKENS_PER_CHAR) + MESSAGE_OVERHEAD

/**
 * 一轮的估算。历史思考不回传（toAssistantParam 只保留本轮），所以只算正文；
 * 阅读链接的页面在签名里，同样不计。含附件的轮次会明显低估，见文档 §三。
 */
export const estimateRoundTokens = ([user, reply]: Round): number =>
  estimateTextTokens(user.content) +
  user.files.length * FILE_BLOCK_OVERHEAD +
  estimateTextTokens(getReplyText(reply))

export const estimateRoundsTokens = (rounds: Round[]): number =>
  rounds.reduce((total, round) => total + estimateRoundTokens(round), 0)

// ---------- 范围选择 ----------

export type CompactionRange = {
  /** 要压缩的轮次，时间正序，至少 1 轮 */
  rounds: Round[]
  /** 被压缩范围的最后一轮回答 id，即保留区的起点 */
  upToMessageId: string
}

/**
 * 从最新一轮往前累加到保留预算为止，前面那段才是可压范围；不切轮次。
 * 至少保留最新一轮：预算为 0（溢出恢复）时正好只剩它；预算被最后一轮自己吃满时也只保留它。
 * 没有可安全压缩的内容返回 null——对应 DSH 的「不动任何东西」。
 */
export const selectCompactionRange = (
  rounds: Round[],
  retainTokens: number
): CompactionRange | null => {
  if (rounds.length < 2) {
    return null
  }
  let index = rounds.length - 1
  let accumulated = estimateRoundTokens(rounds[index])
  while (index > 0 && accumulated < retainTokens) {
    index -= 1
    accumulated += estimateRoundTokens(rounds[index])
  }
  if (index === 0) {
    // 估算认为「全都得保留」：但触发判定用的是真实 usage，图文会话里两者会背离。
    // 这时仍压掉较早的部分，否则长图文会话永远压不动。
    if (rounds.length <= FALLBACK_KEEP_ROUNDS) {
      return null
    }
    const fallback = rounds.slice(0, rounds.length - FALLBACK_KEEP_ROUNDS)
    return { rounds: fallback, upToMessageId: fallback[fallback.length - 1][1].id }
  }
  const compacted = rounds.slice(0, index)
  return { rounds: compacted, upToMessageId: compacted[compacted.length - 1][1].id }
}

// ---------- 摘要请求 ----------

/**
 * 摘要指令，作为压缩请求的最后一条 user 消息。八个 section 与 DSH 的 COMPACTION_INSTRUCTION
 * 一一对应（Primary Request and Intent / Key Technical Concepts / Files and Code / Errors and
 * Fixes / Pending Jobs / Current Work / Next Step / Critical Context）。标题译成中文、规则逐条保留：
 * 本 App 的会话与摘要都是中文，让摘要变成英文再喂回中文对话是净损失。
 */
export const COMPACTION_INSTRUCTION = [
  '你现在充当这次对话的压缩引擎。把上面这段对话整理成一份结构化 checkpoint，让另一个模型能在不丢失关键上下文的前提下接着做。',
  '',
  '严格按下面的 Markdown 结构输出：保留每一个小节、按顺序。用简短的项目符号，不要写成长段落。某一节没有内容就写「（无）」，但绝不省略任何一节。',
  '',
  '## 主要请求与意图',
  '- [用户最初的目标与后续演变；措辞本身重要时原样引用]',
  '',
  '## 关键技术概念',
  '- [涉及的技术、框架、模式与约定]',
  '',
  '## 文件与代码',
  '- [具体路径：为什么重要，关键改动或片段]',
  '',
  '## 错误与修复',
  '- [报错：怎么解决的，以及相关的用户反馈]',
  '',
  '## 未完成的工作',
  '- [用户明确要求、但还没做完的事]',
  '',
  '## 当前进度',
  '- [到这一刻为止正在做什么]',
  '',
  '## 下一步',
  '- [紧接着要做的唯一一个动作，直接对齐最近的请求；没有就写「（无）」]',
  '',
  '## 关键上下文',
  '- [决定及其理由、约束、用户偏好、悬而未决的问题、继续所需的资料]',
  '',
  '规则：',
  '- 用简洁的中文工程语言写。文件路径、命令、报错原文、标识符、数值、函数签名与语法片段必须原样保留。',
  '- 忠实记录用户的反馈与明确指令，尤其是纠正过的地方。',
  '- 不要提到这次摘要请求，也不要提到上下文被压缩过。',
  '- 只输出 checkpoint 文本：不要调用任何工具，不要做任何其他动作。',
  '- 如果上面已经出现过 <compacted-summary> 块，那是上一代 checkpoint。不要照抄：保留仍然成立的事实，丢掉过时的，把新信息合并进同一份结构化的摘要里。',
].join('\n')

/** 压缩指令在回放里的假消息 id，只活在一次请求里，不会落盘。 */
const COMPACTION_QUESTION_ID = 'compaction-instruction'

/** 与 store.ts 的 DEFAULT_MODEL 保持一致，会话里没有模型记录时用它。 */
export const DEFAULT_MODEL: ChatModel = 'deepseek-flash'

/** 与 store.ts 的 SYSTEM_PROMPT 逐字一致：前缀不同，provider 的缓存就命不中。 */
const DEFAULT_SYSTEM_PROMPT = '该助手为DeepSeek，由深度求索公司创造。'

/** 与 store.ts 的 serverTools 同形，工具声明同样属于请求前缀。 */
const compactionTools = (search: boolean): CreateMessageRequest['tools'] => {
  const tools: CreateMessageRequest['tools'] = [
    { type: 'deepseek_read_url', name: 'deepseek_read_url' },
  ]
  if (search) {
    tools.push({ type: 'deepseek_web_search', name: 'deepseek_web_search' })
  }
  return tools
}

export type CompactionRequestOptions = {
  model: ChatModel
  /** 主请求的系统提示词；缺省用与服务端约定的文本 */
  system?: string
  /** 沿用会话的思考设置，压缩请求才与主请求同形 */
  thinking?: boolean
  /** 是否声明联网搜索工具，与主请求一致 */
  search?: boolean
  /** 上一代 checkpoint：它属于被替换的内容，必须排在回放区间之前 */
  previous?: SessionCompaction
}

/**
 * 把要压缩的旧轮次拼成一次摘要请求：前缀（原样回放的历史）+ 最后一条 user 指令。
 * 指令必须是最后一条 user 消息而不是 system——放进 system 会让前缀与主请求分叉，缓存全废。
 */
export const buildCompactionRequest = (
  range: CompactionRange,
  options: CompactionRequestOptions
): CreateMessageRequest => {
  const history: Message[] = range.rounds.flatMap(([user, reply]) => [user, reply])
  const instruction: UserMessage = {
    id: COMPACTION_QUESTION_ID,
    role: 'user',
    content: COMPACTION_INSTRUCTION,
    files: [],
    createdAt: 0,
  }
  // 复用主请求的装配逻辑：转换规则一致，这次调用才可能是主请求的真前缀。
  const messages = toRequestMessages(history, instruction)
  if (options.previous !== undefined) {
    messages.unshift({ role: 'user', content: frameCheckpoint(options.previous.summary) })
  }
  return {
    model: options.model,
    system: options.system ?? DEFAULT_SYSTEM_PROMPT,
    messages,
    thinking: { type: options.thinking === true ? 'enabled' : 'disabled' },
    safety_check: { level: 'high' },
    tools: compactionTools(options.search === true),
  }
}

// ---------- 一次摘要调用 ----------

export type CompactionFailure =
  /** 没有 API Key，摘要模型不可用 */
  | 'no-api-key'
  /** 没有可安全压缩的范围 */
  | 'empty-range'
  /** 模型返回空文本 */
  | 'empty-summary'
  /** stop_reason 是 max_tokens，checkpoint 不完整 */
  | 'truncated'
  /** 摘要没有比它替换掉的原文更短 */
  | 'not-shrinking'
  /** 网络、HTTP 或流错误 */
  | 'request'

export class CompactionError extends Error {
  readonly reason: CompactionFailure
  readonly detail?: unknown

  constructor(reason: CompactionFailure, message: string, detail?: unknown) {
    super(message)
    this.name = 'CompactionError'
    this.reason = reason
    this.detail = detail
  }
}

/**
 * 消费摘要流：只收 text 块，思考与工具调用不进 checkpoint（DSH：只有返回文本进入检查点）。
 * max_tokens 收尾说明 checkpoint 被截断，按失败处理。
 */
const collectSummary = async (
  apiKey: string,
  request: CreateMessageRequest,
  signal: AbortSignal
): Promise<string> => {
  let text = ''
  let truncated = false
  for await (const event of streamMessage(apiKey, request, signal)) {
    if (event.type === 'content_block_start') {
      if (event.content_block.type === 'text') {
        text += event.content_block.text
      }
    } else if (event.type === 'content_block_delta') {
      if (event.delta.type === 'text_delta') {
        text += event.delta.text
      }
    } else if (event.type === 'message_delta') {
      truncated = event.delta.stop_reason === 'max_tokens'
    }
  }
  if (truncated) {
    throw new CompactionError('truncated', '摘要被 max_tokens 截断，checkpoint 不完整')
  }
  const summary = text.trim()
  if (summary === '') {
    throw new CompactionError('empty-summary', '摘要为空')
  }
  return summary
}

// ---------- 编排 ----------

export type CompactionResult = {
  /** 压缩时可见的末轮回答 id；与摘要截止位置不同，用于屏蔽旧 usage。 */
  lastRoundId: string
  /** checkpoint 原文，不含前导与标签 */
  summary: string
  /** 被摘要到的最后一轮回答 id */
  upToMessageId: string
  /** 估算释放的 token 数，压缩前后用同一套估算比较 */
  savedTokens: number
}

/** 覆盖默认请求信封的字段，用于让摘要请求与主请求完全同形。 */
export type CompactionEnvelope = {
  system?: string
  model?: ChatModel
  thinking?: boolean
  search?: boolean
  policy?: Partial<CompactionPolicy>
}

export type CompactionOptions = {
  /** 溢出恢复：忽略保留预算，压掉除最新一轮之外的全部（DSH 的「一次最大平衡头部缩减」） */
  urgent?: boolean
  /** 与主请求同形的信封字段；缺省从会话里推断 */
  envelope?: CompactionEnvelope
}

/**
 * 压缩一次。成功返回摘要与被压到的位置，调用方据此写 session.compaction；其余情况一律抛错，
 * 由调用方决定回退（例如退回百万上下文策略）。取消时抛原始的 AbortError，不要当失败处理。
 */
export const compactSession = async (
  session: Session,
  apiKey: string,
  signal?: AbortSignal,
  options: CompactionOptions = {}
): Promise<CompactionResult> => {
  if (apiKey === '') {
    throw new CompactionError('no-api-key', '没有 API Key，摘要模型不可用')
  }
  const policy: CompactionPolicy = {
    ...COMPACTION_POLICY,
    ...(options.envelope?.policy ?? {}),
  }
  const context = getCompactionContext(getContextRounds(getVisibleMessages(session)), session.compaction)
  const rounds = context.rounds
  let range = selectCompactionRange(
    rounds,
    options.urgent === true ? 0 : getRetainTokens(policy.window, policy)
  )
  if (range === null) {
    throw new CompactionError('empty-range', '没有可安全压缩的轮次')
  }
  const lastReply = rounds.at(-1)?.[1]
  const requestOptions = {
    model: options.envelope?.model ?? lastReply?.model ?? DEFAULT_MODEL,
    system: options.envelope?.system,
    thinking: options.envelope?.thinking ?? lastReply?.thinking ?? false,
    search: options.envelope?.search ?? lastReply?.search ?? false,
    previous: context.previous,
  }
  const stop = signal ?? new AbortController().signal
  const startedAt = Date.now()
  let summary: string
  for (let retry = 0; ; retry += 1) {
    try {
      const cap = outputCapFor(policy.window)
      const body = buildCompactionRequest(range, requestOptions)
      summary = await collectSummary(apiKey, { ...body, max_tokens: Math.min(cap, 8192) }, stop)
      break
    } catch (error) {
      if (stop.aborted) {
        throw error
      }
      // Preserve every uncompressed turn. If the summarizer itself overflows, shorten its prefix.
      if (retry < 3 && range.rounds.length > 1 && isContextOverflowError(error)) {
        const shorter = range.rounds.slice(0, Math.ceil(range.rounds.length / 2))
        range = { rounds: shorter, upToMessageId: shorter[shorter.length - 1][1].id }
        continue
      }
      throw error instanceof CompactionError
        ? error
        : new CompactionError('request', error instanceof Error ? error.message : String(error), error)
    }
  }
  // 字符估算只看得到文本。图文会话里被替换的「原文」几乎全是图片（服务端定价的 token），
  // 用它判断「没变小」会把一份合格的摘要当成失败——这正是「压缩没用」的又一来源。
  const textBefore =
    estimateRoundsTokens(range.rounds) +
    (context.previous === undefined ? 0 : estimateTextTokens(frameCheckpoint(context.previous.summary)))
  const textAfter = estimateTextTokens(frameCheckpoint(summary))
  // 附件也算进「被替换掉的原文总量」：图片按服务端定价的 token 远大于文本，
  // 只把文本算进 before、再拿它跟摘要比，会把合格摘要判成没变小。
  // 但注意不能反过来用 max 给「有附件」兜一个正数——那样任意长的摘要都能过，
  // 压缩反而会让上下文变大。正确口径：before = 文本 + 附件下限，after = 摘要文本。
  const attachmentFloor = range.rounds.reduce(
    (sum, [user]) => sum + (user.files ?? []).length * ATTACHMENT_FLOOR_TOKENS,
    0
  )
  const savedTokens = textBefore + attachmentFloor - textAfter
  if (savedTokens <= 0) {
    throw new CompactionError('not-shrinking', '摘要没有比被替换的历史更短')
  }
  logInfo('compaction', '上下文摘要完成', {
    sessionId: session.id, urgent: options.urgent === true, originalRounds: rounds.length,
    summarizedRounds: range.rounds.length, retainedRounds: rounds.length - range.rounds.length,
    savedTokens, elapsedMs: Date.now() - startedAt,
  })
  return { summary, upToMessageId: range.upToMessageId, savedTokens, lastRoundId: rounds[rounds.length - 1][1].id }
}

// ---------- 溢出与回退 ----------

/**
 * 上下文溢出的识别。DSH 靠适配器把失败规范化成 CONTEXT_WINDOW_EXCEEDED，本 App 只有
 * ApiError.message 可看，只能匹配报文关键词——未对照真实报文，见文档 §八。
 */
const OVERFLOW_PATTERNS = [
  /context[ _-]?(length|window)/i,
  /maximum context/i,
  /prompt is too long/i,
  /too many tokens/i,
  /exceed[s]? .{0,24}tokens/i,
  /上下文.{0,8}(长度|超|上限)/,
  /超出.{0,8}(上下文|窗口)/,
]

export const readContextOverflow = (error: unknown) => {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  const windowMatch = /(?:maximum context length is|context window(?: size)?(?: is| of)?)\s+([\d,]+)\s*tokens/i.exec(message)
  const usageMatch = /requested (?:a total of )?([\d,]+) tokens(?: \(([\d,]+) in the messages, ([\d,]+) in the completion\)|:\s*([\d,]+) tokens from the input messages and ([\d,]+) tokens for the completion)/i.exec(message)
  if (!windowMatch || !usageMatch) {
    return undefined
  }
  const count = (value: string) => Number(value.replace(/,/g, ''))
  const window = count(windowMatch[1])
  const total = count(usageMatch[1])
  const input = count(usageMatch[2] ?? usageMatch[4])
  const output = count(usageMatch[3] ?? usageMatch[5])
  return [window, total, input, output].every(Number.isSafeInteger) &&
    window > 0 && input >= 0 && output >= 0 && total === input + output && total > window
    ? { window, input, output } : undefined
}

export const isContextOverflowError = (error: unknown): boolean => {
  const message =
    error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  return message !== '' && OVERFLOW_PATTERNS.some((pattern) => pattern.test(message))
}

/**
 * 百万上下文回退：压缩不可用时从最早一轮开始丢，直到估算总量回到 W − O 以内。
 * 默认不接：静默丢历史比报错更难排查，是否开启由业务侧拍板。含附件的轮次估算偏低，
 * 这里只按字符量取舍，真超窗口仍由溢出报错兜底。
 */
export const trimRoundsToWindow = (
  rounds: Round[],
  window: number,
  policy: CompactionPolicy = COMPACTION_POLICY
): Round[] => {
  const budget = window - policy.outputReserve
  let total = estimateRoundsTokens(rounds)
  let start = 0
  while (start < rounds.length - 1 && total > budget) {
    total -= estimateRoundTokens(rounds[start])
    start += 1
  }
  return start === 0 ? rounds : rounds.slice(start)
}
