# 白屏一次性诊断快照

目标：**用户导一次日志就能定案**，不再来回猜。

前提（必须写在导出文件里，避免误导）：普通应用**无法证明画面真的显示在屏幕上**。
能做的是把故障缩到某一类，并明确标注「证据不足」。没有证据就写没有证据。

## 一、采什么（按能排除的类别分组）

### ① 视图可见性链（排除「WebView 被隐藏/透明/暂停」）

沿 `getParent()` 逐层采集：`isShown()`、`getVisibility()`、`getAlpha()`、
`getLayerType()`、`isAttachedToWindow()`、`getGlobalVisibleRect()`。

> 注意：Android 没有公开 API 查询 WebView 是否被 pause。只能记录**我们自己**的
> `onPause/onResume/pauseTimers/resumeTimers` 调用，加上视图状态一起看。

### ② 窗口与层级（排除「被遮挡 / 尺寸为 0 / 窗口 flags 异常」）

`getDecorView()` 尺寸、`getWindowVisibility()`、`hasWindowFocus()`、
`isHardwareAccelerated()`、`Window.getAttributes()` 的 `flags/alpha/type`，
以及**遍历兄弟视图**：边界、Z 序、可见性、顺序（查应用内是否有遮挡视图）。

### ③ 绘制与合成（排除「没画」还是「画了没上屏」）

- `ViewTreeObserver.OnDrawListener` / `OnPreDrawListener` 计数 + 末次时间
- `Choreographer` 帧计数
- 同一区域的 `web.draw(Canvas)` 位图非白率 与 `PixelCopy.request(getWindow(), …)` 非白率
  —— 两者的时间、返回码、缩略图都要记

> 边界：`draw()` 走软件绘制，不等价于硬件路径；`PixelCopy` 不含其他窗口遮挡；
> `postVisualStateCallback` 只证明「可绘制」，`registerFrameCommitCallback`（29+）只证明
> 「提交了交换链」。都不等于上屏。

### ④ WebView 回调（排除「渲染进程挂了 / 页面没提交」）

`onPageFinished`、`onPageCommitVisible`、`onRenderProcessGone`（记 `didCrash()`）、
`onReceivedError`。回调**缺失**也要记成「超时未见」，别静默。

### ⑤ 页面侧（排除「页面自己不可见」）

`evaluateJavascript` 取：`document.visibilityState`、`scrollTop`、视口尺寸、
`CSS.supports('height','100dvh')`、`#root` 与顶栏及其祖先的
`getComputedStyle`（`display/visibility/opacity/颜色/关键 CSS 变量/矩形`）。

九宫格命中只记 `tag.class`，**不记元素文本**（隐私）。

### 不要采

全量 DOM、任何正文/附件名/URL、三点白率当结论、设备唯一标识。

## 二、什么时候采

- 启动即开始**环形记录**（最近 N 条，滚动丢弃并记 `dropped:N`）
- 页面加载后 **0.5s / 2s / 5s** 各一次完整快照
- `onPause` / 失焦 / 可见性变化时**立即留一条状态**
- 用户点「导出」时：先冻结历史，再补当前一次 —— 避免导出界面本身污染现场

## 三、零操作也能留下证据

触发条件（满足任一即落盘一次故障快照，**每次启动限一次**）：

- 连续两次 `PixelCopy` 成功且整窗非白率 < 5‰
- `postVisualStateCallback` / `onPageCommitVisible` 超时未见
- 启动后 3 秒内又发生 `onPause`（这次的现场就是这种：`onResume` 后 40ms `onPause`）

快照要包含**触发前 30 条 + 触发后 10 条**，只留一次，写进独立文件
`files/logs/blank-snapshot.log`（≤512 KB，7 天清理）。

## 四、执行约束（这些不遵守就会自己制造故障）

- 所有 View/WebView 调用**必须在主线程**
- 监听器只计数；`OnPreDrawListener` **必须返回 true**，否则会吞掉绘制
- 位图统计、压缩、写盘放后台线程；截图限次 + 超时
- **采集过程中不改状态**：不 resume、不 invalidate、不切 layer —— 先留原状再探测
- 单次快照总耗时上限 300ms，超时就写「采集超时」

## 五、导出文件结构

```
# Deepsleep 诊断快照
# build / os / wx(WebView 版本) / 屏幕 / DPR / 语言
# 结论：<一类> | 证据不足
## 1. 生命周期时间线（含 hasFocus / isShown）
## 2. 视图可见性链
## 3. 窗口与层级
## 4. 绘制与合成（draw 非白‰ / PixelCopy 非白‰ / 帧计数）
## 5. WebView 回调
## 6. 页面状态
## 7. 最近事件（前端 + 原生，带 seq）
## 8. 缺口声明（dropped:N / 未采集项 / 超时项）
```

第 8 节不是可选项：**没有就说没有**，比假装完整有用。
