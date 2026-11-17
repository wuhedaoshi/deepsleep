# 1.2.6：把 372 MB 的会话归档导进手机

对象是用户手上那份 `deepseek_data-2026-11-16.zip`：355 MB 压缩 / 450 MB 明文 / 1314 个 entry。
v1.2.5 导不进去。这份文档讲清楚为什么、改了什么、还差什么。

## 零、先对齐两处前提

接手时拿到的是 `deepsleep-handoff-1.2.5`，里面有 `HANDOFF.md`、两条线的 APK 和源码 zip。有三件事必须先说清楚，否则会照着错的文档改代码：

**1. 文档说的「三段进度 + 全流式」在产物里不存在。**
`HANDOFF.md` §五 写 `backup.ts importHistory(file, onProgress)` 有 opening / reading / writing 三段、`history/zipReader.ts` 负责 `readArchive(file, onEntry)`；`CHANGELOG.md` 的 1.2.3（稳定线）也写「导入改为流式解压，不再把整个 ZIP 读进内存」。

从 `release/核心产物` 里解出来的实际代码不是这样：`Deepseek-API版-1.2.5.apk` 与 `Deepsleep-1.3.6.apk` 的导入模块分别是 `925.ab271cc3.js`（14,465 B）和 `925.2db9ea08.js`（14,508 B），两者的 ZIP 读取器**确实是** `Blob.slice` 定位读，但**调用方仍然把整包读成 chunk 数组再拼一个 `new File(chunks)`**（1.2.5 的 `main.97ec0155.js` 偏移 431743 附近，1.3.6 的 `main.7c6d971c.js` 里同样有 `new File(`）。i18n 里只有 `historyImportReading` / `historyImportWriting`，没有 opening 阶段的 key。

结论：**流式只做到了里层，外层把整包物化了一遍，等于没流式。** 这也解释了为什么 1.2.3 的修复没解决 OOM。

**2. 导入器源码在任何一份资料里都没有。**
`frontend/src/services/chat/history/` 在交接目录、在 `archive/deepsleep-src-1.2.5.zip`（357 个 entry）、在最初的工作区快照里都**不存在**。`HANDOFF.md` 提到 `history/{toLocal,importArchive,zipReader}.ts`，但文件不在包里。所以这次是按 bundle 反推出的行为重写，不是改现成代码。

**3. 版本号有两条线。**
`android/version.properties` 是 `1.2.5`（master 稳定线）。实验线已经用到 `1.3.6`，而且**实验线的 1.2.6 已经被「模型 / 思考强度」这两个设置项占用了**。所以这次要么按 master 线叫 1.2.6，要么在合并两条线时另取号——两者别混着发。

## 结论先行

导不进去不是「解压慢」。是三个成本叠在一起，任意一个单独出现都不致命：

1. **入口先把整包读进 JS 堆**：调用方把文件流读成 chunk 数组再拼成一个 `new File`。实测这一步就要 **727 MB 常驻**（371.8 MB 分块 + 355.2 MB 拼合），发生在任何解析之前。
2. **整条链路在主线程**：368 次 inflate、368 次 `JSON.parse`、943 次附件事务全排在 UI 线程上，加上没有 `largeHeap`，渲染进程被系统回收的概率远高于「慢一点」。
3. **写入是「暂存 + 一次性提交」**：先写 450 MB 到暂存库，再在**一个事务**里把 450 MB 搬进正式库。等于同样的字节写两遍、读一遍。

「云端试过流式解压效果不行」的原因也在这里：流式只削掉了第 1 条里「读」的那一段，第 2、3 条原样保留。而第 1 条真正贵的是**把整包物化成一个 Blob**，不是读文件本身。

1.2.6 的做法：**中央目录定位读 + 按会话推进 + 逐会话落盘 + 分级（正文 / 含附件）**。
本机实测同样这份归档：峰值从 727 MB 降到 **约 220 MB**（只导正文）/ 约 280 MB（含图片），时间 2.3–2.5 s。

## 一、这份归档长什么样

| 项 | 值 |
|---|---|
| 压缩 / 明文 | 355.04 MB / 450.65 MB |
| `manifest.json` | `{"export_format_version": 3}` |
| 会话正文 | `chat_sessions/<会话 id>.json`，368 个，147.24 MB 明文（全部 deflate） |
| 附件 | `chat_sessions/<会话 id>_files/<附件 id>_<原始文件名>`，943 个，303.34 MB（全部 **stored**，不压缩） |
| 索引 | `chat_session_index.json`：标题、`pinned`、`message_count`、时间 |
| 最大单会话 | 28.19 MB / 2371 条消息（当前分支 1358 条）/ 273 张图 |

两个直接影响实现的细节：

- 附件是 **store**（method 0），所以它们根本不需要 inflate——可以整段切 Blob，一个字节都不进 JS 堆。
- 所有 entry 都带 data descriptor（flag bit 3），局部头里的长度字段不可信，**大小只能来自中央目录**。

## 二、v1.2.5 的实际链路（从 APK 产物反推）

`history/` 源码不在任何一份资料里（见第零节），真实链路只能从产物读：`assets/web/static/js/async/925.ab271cc3.js`（导入，14.4 KB）、`5856.62dcb49b.js`（导出，6.4 KB）、`6061.407ab96b.js`（fflate）。
反推的格式化件与逐段说明见 `analysis/current-import/925.pretty.js` 与 `analysis/current-import-path.md`（567 行，结论带 bundle 字符偏移）。

| 阶段 | 现状 | 问题 |
|---|---|---|
| 入口 | 调用方（`main` 里的 `sw`）逐块读入 `chunks` → `new File(chunks)` | 727 MB 常驻，手机上直接判死 |
| ZIP 解析 | 自写读取器：EOCD 尾扫 → 中央目录 → 按 entry 读局部头 + `Blob.slice` 数据段（256 KiB 一块） | 设计是对的，但外层先物化了整包，定位读的意义被吃掉 |
| 解压 | fflate `Inflate`，输入 8 KiB push、输出 ~32 KiB 块 | 没问题，沿用 |
| 顺序 | 强顺序且全串行：`manifest` 必须第一个、会话 JSON 早于 index、图片晚于自己的会话 | 私有格式的耦合；新实现完全不依赖顺序 |
| 校验 | 每条 entry 的每个分片都算 JS CRC32，校验通过才写库 | 全包 450 MB → 本机 973 ms，占 CPU 预算 45% |
| 写入 | 每条会话 1 个事务、每张图 1 个事务（943 次） | 事务次数多、没有批处理 |
| MIME | 图片在 JSON 之后，全部读完后**游标扫全表回填**（`updateStagingFileTypes`） | 又一遍 147 MB 读写 |
| 提交 | `commitStaging()` 在**单事务**里搬 450 MB，先清空再逐条游标 put | 最脆的一步：事务越长越容易中途失败或被杀 |
| 容错 | 单会话失败计数跳过，但末尾的 index 集合一致性检查会因此整包失败 | 「逐会话容错」是假的 |
| 进度 | 只有 reading（按字节）/ writing（按会话数） | 写入阶段百分比是假的（`8 + n*2` 封顶 96%） |

顺带两个旧实现的数据损失（1.2.6 顺手修了一个）：

- `pinned` 恒为 `false`——归档里 `chat_session_index.json` 明明有 `pinned`，解析时却写死。1.2.6 从索引恢复。
- `CONTENT_FILTER` 会话正文被清空（只留 `stopReason: 'refusal'`）。这是与官方语义对齐的行为，**没改**。

## 三、实测成本（本机 Node 24，同一份归档）

分项来自 `analysis/cost-model.md`（7 个 bench，`node analysis/bench/run-all.mjs` 可复跑）：

| 阶段 | 数据量 | 本机 | 手机保守估算 |
|---|---|---|---|
| EOCD + 中央目录 | 224 KB / 1314 entry | 0.4 ms | ≈ 0 |
| 368 会话定位读 + inflate | 51.24 → 147.24 MB | 505 ms（inflate 占 93%） | 3.4 s |
| 943 图片全量读 | 303.34 MB | 161–230 ms | 3.0 s |
| JSON decode + parse | 147.24 MB | 290 ms | 1.7 s |
| fragment → blocks | 34,080 → 21,590 消息 | 84 ms | 0.5 s |
| CRC32（全包，纯 JS） | 450.65 MB | 973 ms | 5.8 s |
| 写回 IndexedDB | 383 MB | 序列化 139 ms | 5.6–13.6 s |
| **整包顺序扫（流式）** | 450.65 MB | 1195 ms / **峰值 191 MB** | — |
| **整包进内存** | 同上 | 589 ms / **峰值 507 MB** | 必撞 WebView 堆 |

结论方向很明确：**桌面快的那条在手机上是崩溃点，慢的那条才落在能活的一侧**。流式多花的 0.6 s 桌面 / 3.6 s 手机，买的是 316 MB 峰值差。

## 四、1.2.6 的实现

```
File/Blob ──► zip.ts        中央目录索引 + 定位读 + stored 零拷贝切片
               │
               ├─► archive.ts   清单（refs）+ 附件表（entry 名直接给 MIME/isImage）
               │
               ├─► toLocal.ts   fragment → blocks、current_message_id 上溯选分支
               │
               └─► importPipeline.ts  小会话优先排序、逐会话推进、进度
                       │
                       └─► db.ts   beginHistoryReplace → putHistorySession（会话 + 附件分批）
```

新增文件（`frontend/src/services/chat/history/`，重建整个缺失目录）。`HANDOFF.md` 里提到的 `zipReader.ts` 对应这里的 `zip.ts`，`importArchive.ts` / `toLocal.ts` 同名保留，`archive.ts` 是新拆出来的一层：

| 文件 | 行数 | 职责 | 旧文件对照 |
|---|---|---|---|
| `zip.ts` | 376 | EOCD → 中央目录一次解析；`stream()` 按 1 MiB 窗口 inflate；`storedBlob()` 对 store 条目直接切 Blob；CRC 可选 | `zipReader.ts` |
| `archive.ts` | 364 | 版本/格式校验、refs 清单、附件表（按 entry 名推 MIME 与 `isImage`）、`sessionOf()` / `attachmentBlob()` | 新增（原来散在 `importArchive` 里） |
| `toLocal.ts` | 484 | 官方 v3 fragment → 本地 blocks；分支上溯；坏会话抛 `BackupError` 让调用方跳过 | `toLocal.ts` |
| `importPipeline.ts` | 171 | 排序、按会话读 → 转 → 写、附件并发 2、进度回调、`done` 续传 | `importArchive.ts` 的一半 |
| `importArchive.ts` | 20 | 与 `db.ts` 接线 | `importArchive.ts` |
| `exportArchive.ts` | 112 | 导出改为本地 v4 格式（见第八节） | `exportArchive.ts`（缺失，重写） |
| `errors.ts` | 12 | `BackupError`，带可展示的文案 key | `errors.ts`（缺失，重写） |

改动：

| 文件 | 改动 |
|---|---|
| `backup.ts:57` | `importHistory(file, options, onProgress)`：不再整包 buffer，直接 `openHistoryArchive(file)`；导出接 `ExportSource` |
| `backup.ts:22` | `ATTACHMENT_SIZE_LIMIT_MB = 128`：超过这个体积的包默认只导正文 |
| `db.ts:248-306` | 新增 `FILE_BATCH=8`、`beginHistoryReplace()`（清库）、`putHistorySession()`（附件按 8 个一批 + 会话与摘要同事务）；删掉已经无意义的 `updateStagingFileTypes()` |
| `store.ts:420-497` | 抽出 `runHistoryReplacement()`；新增 `replaceHistoryProgressively()`（失败时把列表刷成库里的实际内容，而不是继续显示旧列表） |
| `SettingsDialog.tsx:456` | 确认框加「同时导入图片附件」勾选（>128 MB 默认不勾）；进度按已写入字节算百分比 |
| `i18n/{zh,en}.ts` | `historyImportWriting` 改带 `{done}/{total}/{percent}`；新增 `historyImportAttachments`、`historyImportAttachmentsHint`、`historyImportedWithSkipped` |

关键取舍，逐条对应上面的成本：

1. **不解整包**：入口只读尾 64 KB + 中央目录 224 KB，之后按 offset `Blob.slice`。实测只导正文时**只读了 51.6 MB，占整包 15%**。
2. **CRC 只校验会话正文**：图片走 `read(..., false)`。省掉 303 MB 的 JS 逐字节循环。
3. **图片零拷贝**：store 条目直接 `sliceBlob(dataOffset, +size)` 得到 Blob，不经 JS 堆。
4. **MIME 来自 entry 名**：扩展名在扫描 entry 时就知道，附件表先建好——原来那遍「读完再回填」的全表扫描整段删掉。
5. **没有暂存、没有整体提交**：`beginHistoryReplace()` 清库后逐会话写，中断时已写入的会话留在库里可用（`replaceHistoryProgressively` 会把界面刷成实际内容）。
6. **附件分批事务**：8 个一批，943 个附件从 943 次事务降到 118 次。
7. **小会话优先**：按 JSON 明文大小升序，进度条很快过半；最大的那个排最后，卡住也不挡别的会话可用。
8. **分级导入**：>128 MB 默认只导正文。这份归档正文 147 MB、图片 303 MB——先让 368 个会话全部可用，图片以后再说。

## 五、本机实测对比

同一份 372 MB 归档，`node --import ./tools/run-ts.mjs tools/pipeline-bench.mjs <zip>`：

| 口径 | 读取 | 写入 | 耗时 | 峰值 RSS |
|---|---|---|---|---|
| v1.2.5 入口（仅物化整包） | 355 MB | — | 528 ms | **727 MB** |
| 1.2.6 只导正文 | **51.6 MB（15%）** | 36.5 MB | 2298–2458 ms | **217–264 MB** |
| 1.2.6 正文 + 图片 | 353.4 MB（100%） | 338.3 MB | 2463–2507 ms | 270–290 MB |

峰值的两段区间是多次运行的波动，来自 GC 时机（同一份代码，Node 的 `rss` 采样会差 40 MB 左右）；量级差（727 vs 约 220）不受这个影响。

写入量只有 36.5 MB，不是 147 MB——归档里的 147 MB 包含**所有分支**，本地只留当前分支（21,590 / 34,080 条，砍掉 36.6%）。

峰值现在由**最大的单个会话**决定（28.2 MB → 解析 +55 MB、459 ms），不再由整包决定。这既是好消息（包再大也不涨），也是 1.2.6 的新瓶颈（见第七节）。

正确性校验（`tools/import-dryrun.mjs`、`tools/roundtrip.mjs`）：

```
archive  format=official v3 sessions=368 attachments=943 plain=450.6 MB open=20ms
sessions    导入 368 / 368，跳过 0，消息 21590 条
attachments 引用 937 个（归档里找到原件 929 个）
最慢        合同到期不续约补偿  459 ms / 28.2 MB / 1358 条
往返        会话 12/12 一致，原件 318/318 一致
```

## 六、怎么复跑

```powershell
cd deepsleep/frontend
pnpm install                     # 首次
pnpm type                        # 类型检查（必过）
pnpm lint                        # 已知两条历史告警：useEdgeSwipe.ts、AttachSheet.tsx

# 归档放在工作区根目录
node --import ./tools/run-ts.mjs tools/import-dryrun.mjs ..\..\deepseek_data-2026-11-16.zip
node --import ./tools/run-ts.mjs tools/pipeline-bench.mjs ..\..\deepseek_data-2026-11-16.zip
node --import ./tools/run-ts.mjs tools/roundtrip.mjs ..\..\deepseek_data-2026-11-16.zip --count=12
node --expose-gc --import ./tools/run-ts.mjs tools/baseline-bench.mjs ..\..\deepseek_data-2026-11-16.zip
```

工具用 `fs.openAsBlob` 把磁盘文件当 Blob 用，跑的是与手机同一套 `Blob.slice` 路径；
`tools/ts-rewrite.mjs` 负责把源码里 `./x.js` 的写法改指到 `.ts`，Node 24 原生剥类型即可直接跑。

## 七、还没解决的

`HANDOFF.md` §七 已经把「大包导入」列为第一待办，并写「已做流式解压，瓶颈变成单个会话的 `JSON.parse` 峰值（约文本 4–6 倍）；待办：导入前扫中央目录做预检，单会话超阈值就提示；必要时做分片解析」。下面的实测证实了这段判断，也说明它的前半句不成立（整包仍然被物化）。

按「会不会让用户这次导入失败」排序：

1. **单会话 >32 MB 仍会顶堆**。最大那条 28.2 MB → +55 MB 堆、459 ms 桌面（≈1.3 s 手机）。建议 1.2.6 出一个护栏：单条明文超过阈值时提示"这个会话很大，导入会卡一下"，或只保留最近 N 条消息。**目前没做**，因为静默截断数据比慢更糟。`HANDOFF.md` 说的「导入前扫中央目录做预检」正是这一步——`archive.ts` 的 `refs[].bytes` 已经就绪，接个阈值判断即可。
2. ~~**导出仍然一次性在内存里拼 Blob**~~ —— 1.2.8 已修：导出改官方 v3 格式，并经原生 SAF 桥分块写盘（`archiveSink.ts` + `MainActivity`），全程流式，不再物化整包。见 `CHANGELOG` 的 1.2.8 一节。
3. **打开含 273 张图的会话会爆**：`MessageFile` 的 `useFileUrl` 每次挂载都全量读 blob + `createObjectURL`，无缓存；`MessageList` 无虚拟化 → 一次并发 273 次读。真正的内存炸弹还是长截图（1080×25841 的整页截图，原生 RGBA 约 317 MB）。这属于渲染层，不属于导入；因此 1.2.6 对 >128 MB 的包**默认不导图片**。
4. **`persist()` 在 WebView 恒为 false**：450 MB 的 IndexedDB 是 best-effort，系统清缓存会连会话一起清掉。配额本身不紧张（Chromium ≈ 60% 空闲磁盘）。
5. **续传只有钩子没有界面**：`ImportOptions.done` 支持跳过已导入的会话，但还没有"上次导入没走完，继续？"的入口。

## 八、导出格式变了（需要知情）

`exportArchive.ts` 现在导的是**本地结构 v4**（`export_format_version: 4` + `sessions_format: local-v1`），会话 JSON 直接是本地 `Session`：

- 好处：往返无损（实测 12/12 会话逐字节一致），不用把 `blocks` 反推成 `fragments`（服务端工具块的语义反推一次就丢一次）。
- 代价：**我们导出的包，官方网页版/旧版 APK 吃不下**（它们要求 v3，会把 `4` 报成「版本过新」）。
- 兼容方向没变：官方 v3 导出的包**照样能导入**，这条路有 368 个会话的实测覆盖。

如果要跨客户端交换，得把导出改回 v3 fragment 结构——那是另一个活，属于 1.2.7。

## 九、Android 侧与出包（已出，并在 MuMu 上走过真机流程）

产物：`release/Deepseek-API版-1.2.6.apk`（2.32 MB，`versionCode=61` / `versionName=1.2.6`）。

### 9.1 模拟器实测（MuMu 12.0 / Android 12 / WebView 110.0.5481.154 / x86_64）

装包 → 选同一个 372 MB 归档 → 导入 → 开大会话，全程手工点（截图存在 `docs/img/`）：

| 口径 | IndexedDB 落盘 | 渲染进程峰值 RSS | 应用进程 | 结果 |
|---|---|---|---|---|
| 只导正文 | 60 MB | 205 MB | 200 MB | 368/368 会话导入成功，设置里显示「已导入 368 个对话」 |
| 正文 + 图片 | 364 MB（其中 blob 360 MB） | **859.7 MB** | 219 MB | 同样 368/368，写入阶段约 60 s |

导入后打开那个 2371 条消息的会话：能正常打开、滚动不卡（渲染进程从 205 MB 涨到 826 MB）。带 273 张图的会话在图片已入库的情况下打开、滚动、看预览都正常。

另外两件事：

- **数据能跨重启保活**：导入完成后模拟器的 Android VM 重启过一次（`boot_count` 计数增加、adb 掉线、PID 全变），重启后 `IndexedDB` 仍是 364 MB、360 MB 的 blob 一个不少。
- **渲染进程被杀能恢复**：`kill -9` 掉渲染进程后新的 `sandboxed_process0:2` 立刻拉起，应用进程没死，`topResumedActivity` 仍是 `MainActivity`。这验证了 9.2 的 `onRenderProcessGone`。

代价要写清楚：**带图导入把渲染进程推到 860 MB**，是纯正文的 4 倍。300 MB 图片本身不是主因，多出来的是 Chromium 写 IndexedDB blob 时留在渲染进程里的副本与 IPC 缓冲。这就是「>128 MB 默认不导附件」的依据——不是省事，是 4 GB 机上 860 MB 已经在 LMK 的处置区间里。要带图就勾上，慢一点、但能跑。

### 9.2 代码改动

| 文件 | 改动 | 为什么 |
|---|---|---|
| `app/src/main/AndroidManifest.xml` | `android:largeHeap="true"` | 单条 28 MB 的会话解析仍要 +55 MB 堆；没有 largeHeap 时更容易被系统挑中回收 |
| `MainActivity.java` | `onRenderProcessGone`：从视图树摘掉失效的 WebView、`destroy()` 后 `recreate()` | 渲染进程被回收时如果返回 `false`，用户会卡在空白页；而数据其实已经写进 IndexedDB，重建就能看到已导入的部分。已实测生效 |
| `MainActivity.java` | 文件选择结果里逐个 `takePersistableUriPermission` | 导入要跑几分钟，中途 Activity 重建后 `content://` 临时授权失效，用户得重新选文件才能续传；云盘不支持持久授权时忽略，不影响本次导入 |
| `app/build.gradle.kts` | 签名密钥路径改成可用 `-Pdeepsleep.keystore=` 覆盖（默认仍是 Ubuntu 那条） | 原来写死 `/home/ubuntu/...`，换机器就签不了名 |
| `build-apk.ps1` | 新增：Windows 版出包脚本，与 `build-apk.sh` 等价 | 本机是 Windows，`build-apk.sh` 里的 bash 与绝对路径跑不了 |

出包（本机实际操作）：

```powershell
# 工具链在 C:\ds-toolchain（JDK 17.0.2 / Android SDK platform-34 + build-tools 34.0.0 / Gradle 8.7）
# 工程经目录联接 C:\ds-src 访问，绕开中文路径（自用软件）对 aapt2 的影响
cd C:\ds-src\android
$env:DEEPSLEEP_JDK='C:\ds-toolchain\jdk-17'
$env:DEEPSLEEP_SDK='C:\ds-toolchain\android-sdk'
$env:DEEPSLEEP_GRADLE='C:\ds-toolchain\gradle-8.7\bin\gradle.bat'
$env:DEEPSLEEP_KEYSTORE='C:\ds-src\keystore\deepsleep.keystore'
pwsh -File .\build-apk.ps1
```

Ubuntu 上照旧 `cd android && ./build-apk.sh`。

**versionCode 从 32 跳到 61**：这条线（`Deepseek-API版`）的 1.2.5 是 `versionCode=32`，另一条线（应用名 `Deepsleep`）的 1.2.5 / 1.3.6 是 45~50。抬到 60 再 +1，是为了让这一版能覆盖安装到两种已装形态上，数据才保得住。`version.properties` 里已经写了注释。

**签名**：用的是 `keystore/deepsleep.keystore`（从交接包取回），证书 `CN=Deepsleep, O=Deepsleep, C=CN`，SHA-256 `0df0c106…d42ea1`，与 1.2.5 的 APK 完全一致 —— 覆盖安装可继承会话与 API Key。

出包后逐项核对（都是实跑，不是照着文档抄）：

| 检查 | 结果 |
|---|---|
| `aapt2 dump badging` | `package: name='com.deepsleep.app' versionCode='61' versionName='1.2.6'`、`sdkVersion:21`、`targetSdkVersion:34`、`application-label:'Deepseek-API版'` |
| `aapt2 dump xmltree` | `largeHeap(0x0101035a)=true`、`allowBackup=false` |
| `apksigner verify --print-certs` | 与 1.2.5 同一张证书（SHA-256 一致） |
| APK 内 `assets/web/static/js/async/` | 新增 `7131.489afd3a.js`（14,967 B，导入器）、`7061.586dab17.js`（6,428 B，导出器），旧的 `925.*` 已不存在 |
| 包内新导入器特征 | `local-v1`、`sessions_format` 命中；`main.d5c792b1.js` 里已没有整包缓冲（`chunks` 0 次） |
| 包内新文案 | `同时导入图片附件`、`正在导入第 …`、`historyImportAttachmentsHint` 均在 |
| `classes.dex` | `onRenderProcessGone`、`takePersistableUriPermission` 各 1 次 |
| `index.html` | 指向 `static/js/main.d5c792b1.js`，与包内文件名一致 |

安装（真机）：

```bash
adb install -r release/Deepseek-API版-1.2.6.apk
```

**真机还没跑**：MuMu 是 x86_64 + 桌面 CPU，导入 60 秒、860 MB 峰值这些数字到 ARM 手机上都会变差（按第 5 节的 1/6 CPU 折算，导入量级在 3–6 分钟）。手机上要重点看的两件事：4 GB 机型带图导入会不会触发 LMK、以及导入中途切后台再回来是否还在跑（这条在模拟器上没法压出真实的内存压力）。

可选（不是必需）：给本地服务加 `Range`/`206` 与磁盘目录读取，让 JS 通过 `fetch` 拉归档。前端这一版已经把「随机访问」抽象在 `ZipSource` 上，加这条通道不用改导入逻辑；但 `MainActivity.handle()` 现在是整份 `ByteArrayOutputStream` 后写出（`MainActivity.java:409`），要改成就地流式写。**先不做**——`Blob.slice` 这条路在桌面实测够用，native 通道只在真机上发现 `content://` 定位读很慢或文件来源不支持切片时才值得上。

## 十、回滚

- `DB_VERSION` 仍是 **11**，没有升版：降级装回 1.2.5 不会打不开库。
- 暂存库与 `commitStaging()` 保留（「全部删除」还走那条路），旧数据形态不变。
- 回滚代价：1.2.6 导到一半的数据（部分会话）在 1.2.5 里照样能看——它们就是正常记录。
- 唯一不可逆的是**导出格式**：1.2.6 导出的 v4 包，1.2.5 导入会报「文件版本过新」。回滚前把包重导一份即可。


