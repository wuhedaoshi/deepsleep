# CHANGELOG（稳定线 release-1.2）

## 1.2.13（导出保留分支结构）

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
