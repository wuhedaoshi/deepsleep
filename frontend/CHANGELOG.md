# CHANGELOG（稳定线 release-1.2）

## 1.2.17（无扩展名图片也能发；设置里显示真实版本号）

- 白名单放宽：`isAcceptedExt(name)` **或** `isImage(resolveMimeType(file))` 任一成立即接受——
  有些提供方给 `IMG_0001`、`temp` 这类没有扩展名的名字，之前会被直接拒掉；判型最终仍以字节为准
- 设置面板底部新增版本行（`Deepsleep 1.2.17 (133)`），读原生 `getEnvironment()`，
  安装后能直接确认包对不对，不用去系统应用信息里翻
## 1.2.16（选图不再静默失败；图片按真实字节判型）

**根因**：小红书等 App 存下来的图**文件名是 `.jpg`、MIME 报 `image/jpeg`，字节其实是 WebP**。
原来按「声明类型」判断放行，于是 WebP 被当 JPEG 原样上传，服务端按内容拒绝 → 上传失败 →
发送键一直灰、连缩略图都没有。另一位设备的同类图片也就复现成「选完图什么都没发生」。

**修法**

- 新增 `detectImageFormat()`：只看魔数（PNG/JPEG/GIF/WebP/BMP），放行条件与改名都按**真实格式**，不再信 `blob.type`
- 名字/MIME 与字节不符时纠正（JPEG 字节叫 `.png` → 改成 `.jpg` 并重设 MIME）
- MIME 兜底表覆盖全部图片扩展名（补 `apng`/`jfif`/`bmp`）；`application/octet-stream` 一类通用类型按扩展名判型，
  不再把图片当文档绕过归一化
- 需要转换却拿不到 2D canvas → 报 `convertFailed`，不再原样上传

**不再静默**

- `partitionFiles()` 逐文件判定：一张不合格不再拖累整批；失败分四类具体文案（格式 / 尺寸 / 数量 / 解码）
- 相册入口的 chooser 支持「扩展名 → MIME」映射（此前把 `accept` 改成扩展名列表后原生退化成 `*/*`）
- 上传请求与读响应体加 120s 超时；2xx 但 `file_id` 为空当失败；取消后不再发出 POST

**可诊断**

- 启动时记录环境：Android/WebView 版本、`createImageBitmap` / `Blob.arrayBuffer` / `FileReader` / `canvas.toBlob` 可用性
- 每次选图生成诊断 ID，串起「原生 chooser → 收到选择 → 草稿写入 → 图片预处理 → 上传完成/失败」
## 1.2.15（暂停语义 + 图片通路加固）

**暂停与续写**

- `pause_turn` / `stop_sequence` 收进 `stop_reason` 白名单（原来整条 `message_delta` 会被丢弃）
- `pause_turn` 结算为「未完成」而不是「已完成」；缺 `message_stop` 的兜底同样处理
- **联网过的回复不给续写按钮**：官方明确「用过 `deepseek_web_search` / `deepseek_url` 的回复不能续写，会 400」，
  改为提示重新发送；报错状态仍不可续

**图片**

- 老 WebView 没有 `createImageBitmap` 时退回 `<img>` + canvas（原来直接原样上传，服务端回 `unsupported image`）
- 解码前按**文件头**核尺寸（PNG / JPEG / GIF / WebP / BMP），超 40 MP 或读不出尺寸一律拒绝——一张 1 MB 的
  8192×8192 图解码后是 268 MP，老设备会被系统直接杀掉
- 解码只做一次：上传与草稿缩略图共用同一份归一化结果（按 Blob 缓存），并加解码并发闸（最多 2 张）
- 缩略图不再直接拿原文件做 URL（那会让 `<img>` 按原尺寸解码整张图）
- 资源释放放进 `finally`；JPEG 按段跳读，`FF` 填充可跨读取窗口
- AVIF / HEIC 暂时本地明确拒绝（提示格式无法识别），后续按 WebCodecs 单独接入

**注**：稳定线没有上下文压缩，用量圆环仍只显示、不可点击。
## 1.2.14（图片格式兜底 + 暂停语义）

- **老 WebView 图片格式不支持**：`images.ts` 新增 `loadDrawable()`——先 `createImageBitmap`，缺失或解码失败退回
  `<img>` + object URL + canvas。之前没有 `createImageBitmap` 的机型直接原样上传，服务端回 `unsupported image`
- **`pause_turn` / `stop_sequence`**：`parseEvent` 与 `StopReason` 补齐（原来收到 `pause_turn` 整条 `message_delta`
  会被丢弃）；暂停按「未完成」结算，续写时把工具调用与结果原样带上，缺 `message_stop` 的兜底也同样处理
- 注：稳定线没有上下文压缩，所以用量圆环仍只显示、不可点击
## 1.2.13（导出保留分支结构）

### 导入/导出保真（复审十五轮后收口）

**导出侧**

- 父节点必须排在子节点前（官方按 id 升序处理）→ 拓扑排序后编号
- 老线性会话导出前 `normalizeSession()`，避免多个根节点
- 导出前校验：id 唯一 / 父存在 / 无环 / 根必须 USER / 父子角色交替
- 路径安全：过滤 NUL 与控制字符，`session.id` 与 `file.id` 按**官方规则**校验（允许点与非 ASCII）
- 路径去重：NFC 等价名、`a`+`b_c.png` 与 `a_b`+`c.png` 这类撞名统一分配
- 空附件收尾、ZIP32 上限、时间合法性
- 官方 `nullable` 必填键补齐（FILE 的 `width/height`、THINK 的 `elapsed_secs`、TOOL_OPEN 与搜索结果的 `published_at/site_name`）
- **导入时原样留存片段**（`archivedFragments`），导出原样还原并重写 `export_path`：
  保住 `TIP`、`CONTENT_RISK`、`PARTIAL_FILE_READ`、`TOOL_IMAGE_SEARCH`、工具状态、`snippet`、图片尺寸

**导入侧**

- 新增 `paths.ts`：会话 id / 附件路径规则唯一来源（导入与导出共用）
- 附件改为**按 `export_path` 绑定**，不再从文件名拆 id（`f_a` 曾被截成 `f`）
- 绑定三阶段：精确 (id+文件名) 优先 → 前缀仅兜底 → `export_path` 权威（缺失时清除猜测绑定）
- 匹配前统一 NFC（分解形式 `fe\u0301` 也能命中）；路径占用不重复，缺原件保持「只有元数据」
- v4 本地格式没有 `fragments`，按 `message.files[]` 与旧命名补绑定
- 导入管线改走 `archive.sessionOf`（此前绕过绑定，附件原件写入数为 0）

**验收**：官方 10 段片段往返全保留；`s.1` 会话 id、`f_a` 附件 id、撞名路径、缺原件、NFC 等价名、v4 无 fragments —— 全部实测通过。
### 导出的结构性问题（复审后又修了六轮）

- **父节点后置**：官方按 id 升序处理，父 id 必须小于子 id；改为拓扑排序后编号
- **老线性会话**：导出前 `normalizeSession()`，否则所有 `parent_id` 为空、出现多个根
- **脏数据导出成非法包**：导出前校验 id 唯一 / 父存在 / 无环 / 根必须 USER / 父子角色交替
- **路径安全**：过滤 NUL 与控制字符、`session.id` 与 `file.id` 白名单校验（v4 迁入的 `../x` 会被官方拒包）
- **路径撞名**：不同 `(id, name)` 可能拼出同一路径（`a`+`b_c.png` 与 `a_b`+`c.png`），现在统一分配、冲突加序号
- **NFC 与扩展名边界**：路径先 `.normalize('NFC')` 再去重；找扩展名限定在最后一段路径（`s.1` 这类会话 id 不再被改写目录名）
- **空附件**：`blob.size === 0` 也结束流，避免条目永不结束
- **ZIP32 上限**：条目 > 65000 或总量 > 4 GB 明确报错
- **时间合法性**：NaN / 越界时间不再写成 `Invalid Date`

验收：乱序分叉（父<子、当前分支 `问一→答乙→问二`、被弃分支保留）、老会话单根、空附件、恶意文件名/ID、碰撞路径、NFC 等价名 —— 全部断言通过。
- **导出会丢分支**：导出时 `parent_id` 写成「上一条就是父」，重新生成产生的兄弟消息被串成直线，
  `current_message_id` 也不一定是当前分支的叶子。官方 APP 导入后分支被压平。
  现在按本地 `parentId` 映射成官方整数 id，`current_message_id` 指向沿 `selectedChildId` 走到的叶子。
- **老线性会话导出会产生多个根节点**：升级前保存的会话没有分支字段，导出时全部写成 `parent_id: null`，
  官方导入器直接拒绝。现在导出前先 `normalizeSession()` 补齐。
- 验证：分叉会话往返（兄弟关系、当前路径 `1→3→4`）与老线性会话（单根、`current_message_id=3`）各三条断言通过。
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
