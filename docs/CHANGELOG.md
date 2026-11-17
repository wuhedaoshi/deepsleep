# CHANGELOG（稳定线 release-1.2）

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
