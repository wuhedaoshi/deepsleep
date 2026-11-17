# 更新记录

只记「改了什么、为什么改」，不记过程。版本号规则见 `README.DEEPSLEEP.md`。

## 未发布

- 无

## 1.3.9（修：点开图片黑屏、返回键退回新对话）

> 正式线（1.2.8）与实验线共用这段代码，**两个版本都有这个问题**；本版按当前线修，1.2.x 若要继续维护需要同样回移。

- **根因**：消息里的图片是一个 `<a href="blob:…" target="_blank">`。WebView 里 `target=_blank` 要开新窗口，而 `MainActivity.onCreateWindow` 只处理 `http(s)`（交给 `BrowserActivity`），blob 地址落到 `return false` —— 新窗口照样被创建，但没有内容也没有地址可加载，于是黑屏；再按返回键，WebView 的历史被弹掉，SPA 重新加载，`activeId` 归零，看起来就是「回到新对话」。
- **修法（前端）**：不再用链接，改成应用内浮层 `MediaViewer`——图片走 `<img>`、其他类型（PDF/文本）走 `<iframe>`，点遮罩、点 ✕、按返回键（Esc 同一条）都能关。返回键用「打开时 `history.pushState`、关闭时 `history.back()`」实现，所以关浮层时页面本身不动，会话还在。
- **修法（原生）**：`onCreateWindow` 里把非 `http(s)` 的地址改为**静默丢弃**（不再 `return false` 让 WebView 建出空白窗口），并在 logcat 留一行 `onCreateWindow dropped:`。这是兜底：即使以后某处又写了 `target=_blank`，也不会再黑屏。
- **顺带**：普通文件（非图片）原来也是 `window.open`，现在同样进浮层预览；`android/gradle.properties` 加 `android.overridePathCheck=true`，工程放在中文目录里也能构建（本机一直是靠 ASCII 联接目录绕过的）。
- **验证**：`frontend/tools/viewer-check.mjs` 在真实浏览器（Edge）里跑完整链路——导入一个小归档 → 打开会话 → 点缩略图，断言六条全过：缩略图加载（2048×1536）、出现浮层、浮层里是真图片（`naturalWidth>0`）、**没有调用 `window.open`**、Esc 能关、关闭后仍在会话里。配合 `tools/pick-image-session.mjs` 从大归档里挑一条「第一条消息就带图」的短会话做成小包。
## 1.3.8（实验版 · 1.2.8 线 + 自动/手动上下文压缩）

> 基线是 **1.2.8**，不是 1.3.7。两条线各走各的：1.3.7 是 1.3.6 树加导入导出重做，1.3.8 是 1.2.8 加压缩。
> 压缩模块（`compaction.ts`、`reply.ts` 的 checkpoint 装配、store 接线）是同一份代码，只把 1.3.6 才有的
> `LEGACY_1_2_2` 与 `ReasoningEffort` 剥掉，其余逻辑一致。

- **自动压缩**：发送前判定 `needsCompaction`，逼近窗口上限时先把较早的历史摘要成 checkpoint 再发；请求报上下文溢出时用 `urgent` 压一次再重试（只试一次）。压不下来不阻塞发送。
- **手动压缩（本版新增）**：**点上下文用量环**（原本就在输入框那一行里的「1.1M / 1.0M」）或在输入框发送 `/compact`，两条入口都走 `compactNow()`——跳过阈值判断，只要存在可压区间就压。三种结果各有提示：`已压缩上下文` / `没有可压缩的历史（保留区还没被撑满）` / `压缩失败，请稍后重试`。**刻意没有新增按钮**：手机竖屏只有 360~390px 宽，那一行已经排了「深度思考 / 智能搜索 + 环 + 麦克风 + 附件 + 发送」，多一个控件必然挤压原有按钮；环是既有元素，改成 `<button>` 后只重置了 UA 默认样式（`border/background/appearance`），盒子仍是 82×20、字号 12px / 行高 18px，与 span 版逐像素一致。`frontend/tools/layout-check.mjs` 在 390×844 与 360×780 两个视口渲染真实 bundle 量过，原有控件尺寸未变。
- **阈值与保留**：窗口 `W=1M`、输出预留 `O=32768`、余量 `B=65536` → 触发点 `floor(min(W×0.8, W−O−B)) = 800k`；逐字保留 `floor((W−O)×0.16) ≈ 155k`。压力口径与 ContextMeter 一致（未命中 + 缓存命中 + 缓存创建 + 输出）。
- **checkpoint 形状**：DSH 那套 8 段结构（Primary Request / Key Technical Concepts / Files and Code / Errors and Fixes / Pending Jobs / Current Work / Next Step / Critical Context），包在 `<compacted-summary>` 里，前置一段「这是既定背景、别复述、别回应」的前导。压缩指令作为**最后一条 user 消息**追加在回放的历史之后，让摘要请求成为主请求的真前缀，provider 前缀缓存仍能命中。
- **落盘**：摘要存 `Session.compaction`（`summary` / `upToMessageId` / `createdAt` / `savedTokens`），由 `toRequestMessages` 的第 6 个参数注入；锚点不在当前分支上的检查点会被忽略（切版本/分叉留下的摘要不能混进另一条分支）。
- **验证**：`frontend/tools/compaction-e2e.mjs` 用真 store + `fake-indexeddb` + 本地 mock 服务，8 条断言全过（exit 0）——自动：`chat → chat → chat → compaction → chat(checkpoint)`；手动：短历史回报 `nothing`、`/compact` 清空草稿且不进对话、`/compact` 真能压出 checkpoint。设备上确认按钮与 tooltip 渲染正常、点击后走 `compactNow` 并弹提示（无 Key 时是失败分支）。
- **未验到的**：真实模型写出的摘要质量（mock 只证明链路）。
## 1.3.7（1.3.6 线的导入/导出重做）

> 基线从 1.2.8 换到参考包里的 **1.3.6 树**：模型选择、思考强度、价格峰谷那套 UI 全部保留。
> 之前那条 `history/` 是我从 bundle 反推的，1.3.6 里其实有原版源码（`zipReader`/`zipWriter`/`toArchive`/`schema`/`paths` + 一份 6.7 KB 的设计 README），这次直接在原版上改。

- **导出重做**：1.3.6 的 `exportArchive` 把所有条目攒成 `Blob[]` 再拼整包，README 里自己写着「导出会生成完整下载 Blob」——这也是 APK 里点导出没反应的原因。现在 `writeArchiveTo` 边生成边写：`manifest → 每个会话 JSON（紧跟它自己的图片）→ index`，每块输出立刻交给 sink（原生 SAF 落盘或 Blob 拼接），内存里只留当前会话。保留原版 `toArchive` 的高保真映射（模板正文、TIP/CONTENT_RISK、工具块、阅读链接签名）。
- **导入重做**：原来走「暂存库 + 最后整体提交」，370 MB 的包要写两遍才落地。现在 `ArchiveIndex` 只读一次中央目录建清单，再按会话随机读（`sessionOf` + `imageBlob`），每个会话解析完立即写库。分子按本次真实写入量算，进度条不再卡在个位数；单个会话结构异常只跳过它自己，不再因为「索引与会话集合必须一一对应」整包失败。
- **清库不再删 300 MB**：原实现 `beginHistoryReplace` 里带 `files.clear()`，实测在 348 MB 上要 **70 秒**且 CPU 打满。现在只清会话与摘要，原件按 id 覆盖写，导入结束后用 `pruneOrphanFiles()` 分批清孤儿（每批 200 个 key）。
- **修掉两个真 bug**：
  1. 图片 id 解析用了贪婪的 `([^/]+)`，回溯到文件名里最后一个 `_`，写进库的键变成 `fid_IMG_2026...`，而会话摘要引用的是 `fid`，孤儿清理于是把 917/929 张全删了（症状：导入 368 个对话但一张图都没有，导出只报 `images=12/929`）。改成惰性 `([^/]+?)`。这类 bug 在 1.2.8 里踩过一次，这次又踩——所以把复现做成了脚本。
  2. `schema.ts` 的 `nullable()` 只把 `null` 当空，`undefined` 走 `invalid()` 抛错，整条 `FILE` 片段被判非法丢弃。1.2.8 导出的归档不写 `files[].width/height`，于是「导入 1.2.8 的包」永远没有附件。现在缺键也当空。
- **可观测性**：`[export] sessions=N images=X/Y`、`[import] pruned X orphan originals of Y`、单张图片读取失败 `console.warn`、导入失败 `console.error`、落盘路径显示。APK 里没有 devtools，这些是唯一的观测手段。
- **回归脚本**：`frontend/tools/idb-probe.mjs` 用 `fake-indexeddb` 起真库，导入一个带图归档后断言附件没被自己的清理删掉（`PASS`/`FAIL` + 退出码）。上面对应的就是它抓出来的。

**设备实测（MuMu 12 / Android 12 / WebView 110）**：导入 347 MB 官方 v3 归档 → 「已导入 368 个对话」、929 张图片入 360 MB blob；导出 → 381 MB、`[export] sessions=368 images=929/929`、落到 `/storage/emulated/0/Download/deepseek_data-2026-11-17 (5).zip`。
## 1.2.8（导出互通 + 真的落到磁盘）

> 版本号说明：调试期间中间构建把 versionName 推到过 1.3.0–1.3.4、versionCode 到 69。发版把 versionName 定回 1.2.8，
> versionCode 继续单调（70）——两者相互独立，Android 只按 versionCode 判升级。中间那些 APK 已删除，别拿它们当基线。

- **导出改成官方格式（v3）**：从 1.2.6 起导出的是本地结构 v4（`sessions_format: local-v1`），官方网页版与实验版都读不了，等于把自己锁死。现在按官方 `export_format_version: 3` 写：`fragments` 数组、`parent_id` + `current_message_id` 表达分支；消息 id 按顺序重编号成 1..N（官方解析器要求 `Number.isSafeInteger`，本地 id 是 uuid 混数字字符串）。导入侧继续同时支持 v3 与 v4，老包仍可导入。
- **导出真的能落盘**：APK 里 WebView 没有 `DownloadListener`，`URL.createObjectURL` + `a.click()` 什么都不会发生——「导出」以前点了没反应。新增原生桥（`__deepsleepNative.beginArchiveSave / isArchiveSaveReady / getArchiveSaveError / writeArchiveChunk / finishArchiveSave / abortArchiveSave`），经 `ACTION_CREATE_DOCUMENT` 选位置后逐块 Base64 写入；失败/取消/Activity 重建都会 `deleteDocument` 删半成品文件。桌面浏览器没有桥，退回 Blob 下载。
- **全程流式**：fflate 每产出一块就交给 sink（原生桥或 Blob 拼接），不在内存里拼整包；原生侧只入队（8 块 ≈ 4 MiB），写盘在专用线程，队列满时 `writeArchiveChunk` 返回 false 当背压。
- **修掉三个必须知道的坑**：
  1. 桥方法**不能解构**再调用。Chromium 的注入对象不是普通 JS 对象，方法要靠接收者才能找到 Java 实例，`const { f } = bridge; f()` 会抛 `Java bridge method can't be invoked on a non-injected object`。这是本次导出一直失败的真正原因，`archiveSink.ts` 里写成 `(name) => bridge.beginArchiveSave(name)`。
  2. `addJavascriptInterface` 的对象必须用**字段强引用**，行内匿名对象在 GC 之后桥会整体失效——顺带把相机/相册那条老路也稳住了。
  3. Downloads provider 的 documentId 是数字行号（`document/3`），直接回显会变成「已保存到 3」；现在按 API 29+ 的 `RELATIVE_PATH` 或 provider 的 `DISPLAY_NAME` 拼成 `/storage/emulated/0/Download/…`。
- **可观测性**：`MainActivity` 加了 `onConsoleMessage`（JS 的 console 进 logcat），导出链路上每一步都有 `deepsleep` 标签的日志（`beginArchiveSave` / `openArchiveTarget` / `writeArchiveChunk rejected` / `settleArchiveSave` / `finishArchiveSave`）。APK 里没有 `chrome://inspect`，这些日志是唯一能定位问题的手段。
- **已验证（MuMu 12 / Android 12 / WebView 110 实测）**：导出 368 会话 + 929 图片 → 331 MB、1299 个 entry、`manifest` 为 v3；把同一个包导回来 → 「已导入 368 个对话」，IndexedDB 从 15 MB 长到 364 MB；状态行显示 `/storage/emulated/0/Download/…` 真实路径。
- **边界**：`fragments[].style`（TIP / CONTENT_RISK 用）与 `files[].width/height` 本地不存，导出里没有；官方导入器对这两项是可选，但没在官方端实测过。工具类型（TOOL_SEARCH 等）的 `kind`（search / deep_search）是本地派生字段，官方格式没有对应项，往返会按官方规则重算。
## 1.2.7

- 应用改名 `Deepsleep`：`strings.xml` 的 `app_name`、网页标题、`i18n` 的 `appName`（中英）、`package.json` 的 name/description 全部同步。包名 `com.deepsleep.app` 与存储前缀不变，覆盖安装不丢数据（实测：`firstInstallTime` 未变，IndexedDB 仍 364 MB）。
- 图标换成 Q 版鲸鱼娘：五档 mipmap（48/72/96/144/192）取自参考包 `Deepsleep-1.3.6.apk`，逐档 SHA-256 与之一致；网页侧 `icon-*` 与 manifest 本来就是这套，无需改动。
- 产物命名改为 `Deepsleep-<版本>.apk`（`build-apk.sh` / `build-apk.ps1` 同步）。
- 已出包：`release/Deepsleep-1.2.7.apk`，2.4 MB，`versionCode=62`，签名证书与前几版一致。

## 1.2.6（稳定线 · 大包导入）

> 版本号注意：实验线（`experimental-1.3`）已经用 1.2.6 发布过「模型 / 思考强度」，两条线合并时以合并方的版本表为准，别混着发。

- **已出包**：`release/Deepseek-API版-1.2.6.apk`，2.32 MB，`versionCode=61` / `versionName=1.2.6`，签名证书与 1.2.5 一致（SHA-256 相同），可覆盖安装。
- **已在 MuMu 12（Android 12 / WebView 110）走完整流程**：372 MB 归档导入 368/368 个会话；只导正文时 IndexedDB 60 MB、渲染进程峰值 205 MB；带图片时 IndexedDB 364 MB、渲染进程峰值 860 MB；2371 条消息的会话与 273 张图的会话都能正常打开和滚动；导入完成后模拟器重启过一次，数据完整；`kill -9` 掉渲染进程后新渲染进程自动拉起、界面恢复。
- `versionCode` 从 32 抬到 61：这条线 1.2.5 是 32，另一条线（`Deepsleep`）1.2.5/1.3.6 是 45~50，抬到 60 再 +1 才能覆盖安装到两种已装形态上。`version.properties` 里有注释。
- 新增 `android/build-apk.ps1`（Windows 出包，与 `build-apk.sh` 等价）；`app/build.gradle.kts` 的签名密钥路径改为可用 `-Pdeepsleep.keystore=` 覆盖，默认仍是 Ubuntu 那条。

- 大归档导入重做：不再把整包读进内存，改为「中央目录定位读 → 按会话解压 → 逐会话落盘」。372 MB / 450 MB 明文的包，峰值从 727 MB 降到约 220 MB（只导正文），全程不再有「暂存 + 一次性提交」的第二次 450 MB 拷贝。
- 修的是文档与产物之间的一个缺口：1.2.3 起宣称「流式解压」，实际上只有里层 ZIP 读取器是 `Blob.slice` 定位读，调用方仍然把整包读成 chunk 数组再 `new File(chunks)`（`main` 里那一步 727 MB）。产物才是事实，`HANDOFF.md` 里写的 opening / reading / writing 三段进度在 bundle 中不存在。
- 新增 `services/chat/history/`（`zip.ts`、`archive.ts`、`toLocal.ts`、`importPipeline.ts`、`importArchive.ts`、`exportArchive.ts`、`errors.ts`）。这个目录在交接目录、在 `archive/deepsleep-src-1.2.5.zip`、在最初的工作区快照里都不存在，`backup.ts` 的三处引用一直悬空；这次按 bundle 反推的行为重写。
- 图片附件走 store 条目的零拷贝切片（归档里 943 张图都不压缩），MIME 直接取 entry 扩展名——原来「读完再扫全表回填 MIME」的那一遍删掉。
- CRC32 只校验会话正文，跳过 303 MB 的图片：纯 JS 逐字节校验原本占导入 CPU 预算的 45%。
- 附件写入改为 8 个一批事务（943 → 118 次），会话与摘要同事务。
- 导入不再依赖 entry 的物理顺序（原来要求「manifest 第一、会话 JSON 早于 index、图片晚于自己的会话」）；单会话损坏只跳过它本身，不会再被末尾的集合一致性检查判成整包失败。
- 恢复归档里的 `pinned`（旧实现写死 `false`，`chat_session_index.json` 里其实有）。
- 导入确认框新增「同时导入图片附件」，>128 MB 的包默认不勾：正文只有图片的四分之一，先让会话全部可用。
- 进度按已写入的明文字节算百分比，并显示 `已导入 n/N`；导入中断时列表刷新成库里的实际内容（`replaceHistoryProgressively`），不再显示已经不存在的旧列表。
- 导出格式改为本地结构 `export_format_version: 4`（`sessions_format: local-v1`），往返无损；官方 v3 包仍可导入。跨客户端交换需改回 v3，见 `docs/PLAN-1.2.6.md` 第八节。
- Android：`largeHeap`、渲染进程被杀后重建界面（`onRenderProcessGone`）、文件选择拿持久读权限（`takePersistableUriPermission`）。
- 新增 `frontend/tools/`：`import-dryrun.mjs`、`pipeline-bench.mjs`、`roundtrip.mjs`、`baseline-bench.mjs`，用真实归档在 Node 里复跑导入链路（`tsconfig` 只 include `src`，不影响 `pnpm type`）。

## 1.2.5

- 应用显示名改回 `Deepseek-API版`（此前短暂改为 `Deepseek-API版本`）。仅显示层：包名、存储前缀、签名均未变，覆盖安装不丢数据。

## 1.2.4

- 应用显示名改为 `Deepseek-API版本`：桌面名、网页标题、侧边栏名称、npm 项目名同步。
- 构建输出文件命名随之改为 `Deepseek-API版本-<版本>.apk`。

## 1.2.3

- 无代码改动。目录重组后重新构建，用于验证 `build-apk.sh` 流水线（前端产物 → assets → Gradle → 签名 → 导出）。

## 1.2.2

- 关闭 Android 系统备份：`allowBackup=false`、`fullBackupContent=false`，新增 `res/xml/data_extraction_rules.xml` 全量排除云备份与设备迁移。会话、附件、API key 不再进系统备份；换机改为手动导出 ZIP。

## 1.2.1

- 修表格和代码块无法横向滚动：`useEdgeSwipe` 增加「横向可滚动容器让路」判断（向上 8 层检测 `overflow-x` 与 `scrollWidth`）；表格 wrapper 与代码块加 `data-no-swipe`、`touch-action: pan-x`、`-webkit-overflow-scrolling: touch`。

## 1.2.0

- 修「点网页链接返回后回到新对话首页」：外链改为打开独立 `BrowserActivity`（独立 WebView + 返回箭头 + 进度条）。此前在对话 WebView 内加载外链，返回时 SPA 重新加载，`activeId` 丢失。
- 版本号规则改为满 9 进一位（`1.1.9 → 1.2.0`）。

## 1.1.9

- 修外链返回栈：实现 `onCreateWindow` 与 `shouldOverrideUrlLoading`，`target=_blank` 与普通外链不再交给外部浏览器。

## 1.1.8

- 修语音输入静默失败：`onPermissionRequest` 先检查并补申请 `RECORD_AUDIO` 运行时权限，拿到结果后再 grant WebView 请求；清单补 `MODIFY_AUDIO_SETTINGS`。

## 1.1.7

- 批量管理视觉对齐官方：圆圈 26px、选中蓝底白勾、行高 52px、字号 17px。
- 修搜索框下方黑线：`.searchRow` 由 `div` 改为 `button` 后未清默认边框。

## 1.1.6

- 批量管理：标题随选中数变化（“已选择 N 个对话”）、勾选圈加白色对勾、底部按钮改灰/红配色。

## 1.1.5

- 修批量管理模式选中态样式与官方不一致（勾选圈、标题、按钮配色）。

## 1.1.4

- 置顶真正生效：`Session` / `SessionSummary` 增加 `pinned`，`sortSessions` 置顶优先，新增 `pinSessions()` 并持久化。此前按钮只清空选中，没有写数据。

## 1.1.3

- 修搜索页只盖住半屏：改用 `createPortal` 挂到 `document.body`（抽屉的 `transform` 会让 `position: fixed` 以抽屉为参照）。
- 修搜索页要按两次返回：打开搜索前先收起抽屉。
- 批量管理页头改为「选择对话 + 圆形 ×」，底部改为「置顶 | 删除」。

## 1.1.2

- 修「搜索框变全屏」的需求理解错误（此前只做了半屏覆盖），见 1.1.3 的最终形态。
- 侧边栏删除「开启新对话」按钮（顶栏已有 `+`）。
- 新增批量管理入口与多选、删除。

## 1.1.1

- 搜索改为真正的全文检索：新增 `services/chat/search.ts`，懒建索引 + 会话指纹失效；标题命中优先，正文命中带上下文片段。
- 结果列表防抖 180ms，检索期间保留上次结果。

## 1.1.0

- 版本号递增规则修正（此前出现 `1.0.10`，应为 `1.1.0`）。

## 1.0.9

- 手势改为全屏右滑开抽屉（原 44px 边缘感应区太小，实测很难命中）。

## 1.0.8

- 相册选择退化为「全部文件」：`accept` 是 `image/*` 时保留 MIME，是扩展名列表时退回 `*/*`。

## 1.0.7

- 修文件选择器「最近」为空：不再把扩展名当 MIME 传给 `EXTRA_MIME_TYPES`。
- 滑动手势改为跟手位移（拖动实时写 `transform`，松手才补过渡），位移与过渡从 CSS 移交 JS。

## 1.0.6

- 侧边栏改为「推挤」效果：抽屉打开时主内容 `translateX(min(300px, 78vw))` 并加圆角投影。
- 毛玻璃改为内层元素承载（带 `transform` 的元素上 `backdrop-filter` 会被禁用）。
- 文件选择改用 `ACTION_OPEN_DOCUMENT`，进入系统文件管理器的分类界面。

## 1.0.5

- 拍照改走原生 Intent（`__deepsleepNative.takePhoto`），WebView 的 `<input capture>` 在国产 ROM 上无效。
- 新增边缘/全屏滑动手势 hook `useEdgeSwipe`。
- 抽屉加毛玻璃。

## 1.0.4

- 移动端上传改为底部抽屉（拍照 / 相册 / 文件）。
- 侧边栏改成常驻挂载 + `data-open` 驱动位移，带退场动画。

## 1.0.3

- 新增上下文用量环（`ContextMeter`，取最后一次请求的 `usage` 汇总，上限 1M）。
- 修构建脚本导出文件名用递增前的版本号。

## 1.0.2

- 新增每条回复的花费（`pricing.ts`，含峰谷时段）与设置页账户余额（`GET /user/balance`）。

## 1.0.1

- 对话分叉按钮从用户消息移到 AI 回复；图标换成 DSH 的 `IconBranchOutlineRegular` 同款路径。

## 1.0.0

- 基于官方 chat-demo 完成品牌化：应用名 `Deepseek-API版`，包名 `com.deepsleep.app`，存储前缀 `deepsleep:`，IndexedDB 名 `deepsleep`。
- 图标换为 DS 官方鲸鱼 logo（5 档 mipmap + PWA manifest）。
- 导入：`buildTree` 只取当前分支；`importArchive` 逐会话容错；新增导入进度条。
- APK：minSdk 21 / targetSdk 34，构建目标降到 `chrome >= 80`，修 `uses-sdk` 缺失导致的「为旧版安卓打造」。
- 外壳：本地 HTTP 服务（127.0.0.1:8731）提供 assets，WebView 文件选择与相机桥接。









