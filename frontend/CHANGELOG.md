# CHANGELOG（稳定线 release-1.2）

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
