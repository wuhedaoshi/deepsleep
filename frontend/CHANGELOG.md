# CHANGELOG（稳定线 release-1.2）

## 1.3.18 · 实验线（相册选择结果解析修复）

= 稳定线 1.2.18 全部内容。本版修的是**「相册选完图什么都没发生」**的根因：
`FileChooserParams.parseResult` 在我们自建的 chooser 上会返回 null（真机日志 `code=-1 uris=null`），
现改为手工解析 `ClipData` / `data`，相册走系统 Photo Picker，回调先清空再解析。
## 1.3.17 · 实验线（无扩展名图片 + 版本行）

= 稳定线 1.2.17 全部内容（含压缩相关保持 1.3.16 状态）：

- 按 MIME 接受无扩展名的图片（`IMG_0001` / `temp` 这类名字）
- 设置面板底部显示真实版本号
## 1.3.16 · 实验线（选图不再静默失败 + 图片按真实字节判型 + 全链路诊断）

= 稳定线 1.2.16 全部内容，另含：

- 用量圆环点击压缩的结果提示与 `/compact` 共用（1.3.15 起），本版保持不变
- 诊断链路覆盖压缩相关日志（`compacting` 状态、`compactWithFeedback` 结果）

**本版核心**

- 图片放行与改名按**真实字节格式**判定（修「小红书存图是 WebP 却命名 .jpg」被原样上传）
- `partitionFiles` 逐文件判定 + 四类具体失败文案；chooser 扩展名→MIME 映射；上传 120s 超时与 abort 自查
- 启动记录 Android/WebView 版本与能力位；每次选图一个诊断 ID 串联全链路
## 1.3.15 · 实验线（圆环压缩反馈 + 暂停语义 + 图片通路加固）

= 稳定线 1.2.15 全部内容，另含：

- **点用量圆环即可压缩**：`<span>` → `<button>`，触控区 28px、抑制长按选字；`/compact` 与点击共用
  `compactWithFeedback`（同一条结果提示，重复点击静默）。原来点了没有任何反应
- 压缩进行中禁用按钮；命中「无可压区间」时给出明确提示而不是静默
## 1.3.14 · 实验线（圆环点击压缩 + 图片兜底 + 暂停语义）

- **用量圆环可点击触发压缩**：`ContextMeter` 由 `<span>` 改成 `<button>`，点击立刻 `compactNow`
  （原来只有显示，点了没反应）；压缩中禁用，补 hover / focus-visible
- **老 WebView 图片兜底**：`loadDrawable()` 先 `createImageBitmap`，缺失或失败退回 `<img>` + canvas
- **`pause_turn` / `stop_sequence`**：收白名单；暂停结算为 `stopped`；续写把工具调用与结果原样带上
  （纯工具块的暂停也能续）；报错状态仍不可续；缺 `message_stop` 的兜底同样按暂停处理
## 1.3.13 · 实验线（导入/导出保真收口；与稳定线 1.2.13 同补丁号）

在稳定线 1.2.13 的全部内容之上，含上下文压缩。本轮补的是**导入/导出保真**（两边同源）：

**导出**：拓扑编号（父先于子）、老会话 normalize、树与角色校验、路径安全与去重（含 NFC）、
官方 `nullable` 必填键补齐、`archivedFragments` 原样留存还原（保住 `TIP`/`CONTENT_RISK`/
`PARTIAL_FILE_READ`/`TOOL_IMAGE_SEARCH`/工具状态/`snippet`/图片尺寸）。

**导入**：新增 `paths.ts` 统一 id 规则；附件改按 `export_path` 绑定（不再拆文件名，
`f_a` 曾被截成 `f`）；三阶段绑定（精确 → 前缀兜底 → export_path 权威且缺失时清除猜测）；
NFC 统一与路径占用；v4 无 `fragments` 时按 `message.files[]` 补绑；导入管线改走 `archive.sessionOf`。

**验收**：官方 10 段片段往返全保留；`s.1`、`f_a`、撞名路径、缺原件、NFC 等价名、v4 无 fragments 全通过。
## 1.3.13 · 实验线（导出结构性修复；与稳定线 1.2.13 同补丁号）

导出侧七轮复审后的全部修复（与稳定线同源）：

- **父节点后置**：改为拓扑排序后编号，保证父 id < 子 id
- **老线性会话**：导出前 `normalizeSession()`，避免多个根节点
- **导出前校验**：id 唯一 / 父存在 / 无环 / 根必须 USER / 父子角色交替，脏数据明确报错
- **路径安全**：过滤 NUL 与控制字符、`session.id` 与 `file.id` 白名单
- **路径撞名**：统一分配路径，冲突加序号；`export_path` 与 ZIP 条目严格对应
- **NFC 与扩展名边界**：路径先归一化再去重；扩展名只在最后一段路径查找
- **空附件收尾**、**ZIP32 上限**、**时间合法性**

压缩修复（1.3.12 起）：usage 部分字段可解析、`mergeUsage` 按字段合并、缺 usage 走估算兜底、
窗口可设置（`1400000` / `1.4m` / `300k`）、图文会话可压、`not-shrinking` 修正、判定可解释。
## 1.3.12 · 实验线（压缩修复；与稳定线 1.2.12 同补丁号）

首次 1.3.12 构建复审又发现两处，本版（同一 1.3.12，versionCode 128）修掉：

- **压缩可能越压越大**：`savedTokens` 原用 `Math.max(文本缩减, 附件下限)`，只要有附件结果恒为正，
  任意长摘要都会被接受。改为把附件计入「被替换掉的原文总量」：`textBefore + attachmentFloor - textAfter`。
- **打错字会把窗口设置清掉**：非法输入被解析成 `null` 并写回，等于恢复默认 1M，让 300k 窗口的模型推迟压缩。
  现在只有**空输入**才恢复默认，非法输入保留原设置。

验收脚本补了三条断言：空串→null、非法→null、`1.4m`→1,400,000。

规则：**实验线与稳定线共用补丁号**——稳定线 1.2.12 ↔ 实验线 1.3.12；同一补丁号内用 versionCode 递增区分构建。
## 1.3.12（实验线：修「压缩在部分机型上不起作用」）

三个叠加的原因，全都不是机型性能问题：

1. **`usage` 缺一个字段就整体丢弃**：`parseEvent` 原来要求四个用量字段全是数字，少一个就得到
   `undefined`；而判定遇到 `undefined` 直接判「不压」。现在只要有一个数值字段就接受，缺的补 0 并记下字段名。
2. **导入的历史没有 usage**：官方归档导入的 assistant 消息不带 `usage`，导致这些会话的自动压缩永久失效。
   现在 `usage` 缺失时**复用字符估算**兜底，并标注 `source=estimate`。
3. **窗口写死 1M、没有设置项**：用户把窗口当 300k 或 1.4M 用，代码从未读取。
   现在窗口单一来源 `resolveWindow(model, override)`，设置里可填任意值（留空 = 模型默认，1.4M 写作 `1.4m` 也认）。

配套改动：

- 判定改为可解释的 `evaluateCompaction`：返回 `pressure / threshold / source / triggered / reason`
  （`below-threshold` / `nothing-to-compact` / `already-compacted` / `no-estimate`）
- 防重复压缩从「比时钟」改成「比最后轮次 id」，并兼容旧存档
- 压缩失败不再静默：记录原因，发送照常继续
- 上下文用量仪表复用同一判定，tooltip 显示压力、阈值与来源
- 阈值边界统一为 **严格大于**（`pressure > threshold` 才压），仪表与判定同口径

验收脚本 `frontend/tools/verify-compaction.mjs`（本地跑，不访问真实 API）：
窗口 300k → 阈值 201,696 / 1.4M → 1,120,000；阈值边界、部分 usage、缺 usage 走估算、
压后不重复、切分支隔离、设置持久化、store 集成 共 9 组断言全过。
## 1.3.11（实验线：并入稳定线全部修复 + 上下文压缩）

- 并入 1.2.12 的全部修复：白屏根因（`var()` 内 `dvh` 导致 height=auto）、导入官方归档保留分叉、回车键行为可设置、上传失败归因、日志系统完善与审计修正
- 保留上下文压缩（`/compact`、手动压缩入口、checkpoint 摘要）
- 与稳定线的唯一差别就是压缩功能；其余代码一致
## 1.2.12（白屏根因、分支导入、回车设置、日志完善）

### 白屏（真因已在真机日志上闭环）

- **根因**：`height: var(--app-viewport-height, 100dvh)`。`var()` 的替换在计算值阶段发生，
  引擎不支持 `dvh` 时整条声明「计算值阶段无效」，`height` 取初始值 `auto` —— **不会回退到上一条 `100vh` 声明**。
  `.frame` 是 `position:fixed; bottom:auto; overflow:hidden`，`auto` 高度塌成 0，内容被整块裁掉；
  设置弹窗走 portal 挂在 `body` 上不受裁剪，于是出现「弹窗看得见、底层全白、关掉弹窗全白」
- **最小实验**：`height:123px; height:var(--x,100furlong)` 计算结果是 **0px**（123px 被丢弃）；
  只有把不支持的单位直接写在属性上（非 `var`）才会回退
- **修法**：`100vh` 保留，`dvh` 版本挪进 `@supports (height: 100dvh)`；同样写法在
  `ChatInput.module.css`、`Settings.module.css` 一并修正
- 撤掉此前所有基于错误判据的自动恢复（`recreate()` 阶梯、`web.onPause()`、`INVISIBLE→VISIBLE` 重挂、`LAYER_TYPE_HARDWARE`）

### 回车键行为可设置

- 设置里可选「回车发送」或「回车换行」，`Ctrl/⌘+Enter` 始终发送
- 中文输入法选词不再误发送：`isComposing` + `keyCode 229` 双重判断

### 导入官方归档保留分叉

- 此前只沿 `current_message_id` 取一条链，**重新生成产生的兄弟消息在导入时就被丢弃**
- 现在导入全部消息建树：`parentId` 连父子、沿当前路径写 `selectedChildId`、`rootMessageId` 指向路径根
- 校验：父子角色交替、所有根必须是 USER、id 唯一、无环（迭代标记，非 O(n²)）、深链不递归
- 缺 `current_message_id` 时按同父最大 id 选当前分支（与官方一致）

### 「发你好回报上传失败」

- 错误按 401/402/413/429/网络细分，不再一律叫「上传失败」
- 只有真要传附件时才归到上传；无附件时的运行时缺失（方法不存在/不可迭代）才提示运行环境问题
- Key 校验加 15 秒超时，超时按网络异常提示（此前真机出现 37 秒才报 `Failed to fetch`）

### 清理：稳定线不再携带实验版文案

i18n 里混进了 `compactNow` / `contextCompacting` 等 7 个上下文压缩的键（代码从未引用，是跨分支同步时带过来的）。
稳定线不含压缩功能，这些键已删除，避免用户看到「压缩上下文」却找不到入口。

### 运行日志（按诊断方案完善）### 运行日志（按诊断方案完善）

- 每条带单调序号 `#seq`，前端段与原生段可对齐
- 环形缓冲挤出时记 `dropped`，导出文件开头**声明缺口**
- 异常只记类型名与错误码，不记原文；九宫格只记 `tag.class`，不含元素文本
- 新增 `DiagnosticSnapshot`：视图链 / 窗口层级 / 兄弟视图 / 绘制计数与 `commitVisible` /
  自绘非白‰ / PixelCopy 非白‰ / 地标像素 `minLum+std` / `frameRect`
- 采集约束：主线程只做视图读取，像素统计走后台线程；抓屏限流；`onDestroy` 前 dispose，回调带 `disposed` 检查
## 1.2.11（运行日志 + 白屏修复）

### 运行日志（便于排查）

- **只记事件与计数**：启动、导入进度、请求状态码、错误摘要、渲染进程被杀；**不含对话正文、图片内容、API Key**
- 写盘前脱敏：`sk-…`、`Bearer …`、长 base64、`/data/user/0/…` 与 `C:\Users\<name>` 一律替换
- 三种看法：设置 → 数据管理 →「运行日志」（查看/刷新/复制/导出）；文件 `Android/data/com.deepsleep.app/files/logs/deepsleep.log`；面板里的「导出」走系统保存对话框
- 体积有上限：单文件 2 MB 封顶，超过滚成 `.1`（旧的一份直接删），磁盘占用最多约 4 MB；实测一次十分钟的正常操作约 6.6 KB
- 兜底：渲染期异常由错误边界接管（显示摘要 + 复制），不再留一片白；连续两次启动没走完会进恢复界面（不加载历史，可导出日志 / 清空会话 / 再试一次）

### 白屏修复

- 移动端框架高度补 `100vh` 兜底：老 WebView 不认 `dvh` 时 `height` 会退化成 `auto`，`position: fixed` 的框架塌成 0 高度
- 去掉全部常驻 `will-change: transform`：整页合成层在 `onStop → onResume` 后可能不重绘，DOM 正常但屏幕全白
- 原生：显式 `LAYER_TYPE_HARDWARE`；`onPause/onResume` 驱动 WebView；从后台回来重新挂载一次视图，逼它重建 surface
- 整屏 `backdrop-filter` 移除（Mali GPU 上同样有整层渲染成白的风险）
## 1.2.10（修：历史里有 webp 时长会话发不出去）

从 1.3.x 回移。群里有反馈：长对话报 `messages.40.content.0: You have uploaded an unsupported image`，短对话没事。

- **根因**：图片按 Files API 的 `file_id` 以 `image` 块引用，服务端只认 JPEG/PNG；而客户端接受 webp/bmp/gif 并原样上传。坏 `file_id` 会跟着历史一直重发，所以那个会话再也发不出去；短会话没图，看不出来。
- **修法**：① 上传前用 canvas 把非 JPEG/PNG（以及长边 > 2048）转成 JPEG；② 把「unsupported image」归入附件失效一类，命中后清掉可疑图片的 `serverId` 再重试一次，仍不行就把该会话的图片从上下文里摘掉——本地原图仍在、界面照常显示，只影响上下文；③ 中文提示说明原因。
- **验证**：`tools/unsupported-image-e2e.mjs` 六条断言全过（`chat(0 img) → chat(1 img, 400) → chat(0 img, 成功)`）；转码在浏览器里验过 webp 3000×1500 → jpeg 2048×1024。
本分支是 **1.2.x 稳定线**：功能停在 1.2.8，只随 1.3.x 主线修复严重缺陷回移。
当前版本 **1.2.9**。

## 1.2.9（修：点开图片黑屏、返回键退回新对话）

从 1.3.9 回移。正式线与实验线共用这段代码，两个版本都有这个问题。

- 消息里的图片原本是 `<a href="blob:…" target="_blank">`：WebView 要开新窗口，而
  `onCreateWindow` 只处理 `http(s)`，blob 落到 `return false` —— 新窗口建出来但没有内容，
  于是黑屏；返回键再把页面历史弹掉、SPA 重新加载，表现为「回到新对话」。
- 改为应用内浮层 `MediaViewer`（图片 `img` / 其他 `iframe`），遮罩、✕、返回键都能关；
  返回键用 `pushState + popstate`，关浮层时页面不动、会话还在。普通附件同样走浮层。
- 原生兜底：`onCreateWindow` 对非 `http(s)` 地址改为静默丢弃，不再让 WebView 建空窗口。
- 验证：`frontend/tools/viewer-check.mjs` 在真实浏览器跑完整链路，六条断言全过。

## 1.2.8 及更早

见 `main` 分支的 `docs/CHANGELOG.md`（1.2.8 一节起）。
