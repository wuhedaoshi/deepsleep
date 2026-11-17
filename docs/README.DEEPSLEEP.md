# Deepseek-API版（Deepsleep）

基于官方 [chat-demo](https://github.com/deepseek-ai/chat-demo)（MIT）二次开发的本地聊天客户端。前端是官方那份静态 SPA，外面套了一层 Android WebView 外壳，打包成可安装的 APK。

这个文件是**给维护者看的**：上游是谁、我们改了什么、怎么从零重建、坑在哪。上游原版的 `README.md` / `README.zh-CN.md` 保持不动。

## 目录

- [仓库结构](#仓库结构)
- [工具链与固定路径](#工具链与固定路径)
- [从零重建（四条命令）](#从零重建四条命令)
- [相对上游的改动清单](#相对上游的改动清单)
- [签名与版本号规则](#签名与版本号规则)
- [已知坑与排错](#已知坑与排错)
- [跟进上游](#跟进上游)

## 仓库结构

整个项目收在一个目录下，四个子目录各管一段：

```
/home/ubuntu/deepsleep/
├── frontend/            前端（官方 chat-demo + 我们的改动）
│   ├── src/             React + rspack
│   ├── dist/            pnpm build 产物，构建时整体拷进 APK
│   ├── README.DEEPSLEEP.md
│   └── CHANGELOG.md
├── android/             Android 工程（标准 Gradle）
│   ├── app/src/main/java/com/deepsleep/app/
│   │   ├── MainActivity.java     WebView + 本地静态服务 + 原生桥
│   │   └── BrowserActivity.java  外链用独立 WebView
│   ├── app/src/main/assets/web/  构建时从 frontend/dist 拷入
│   ├── build-apk.sh              一条命令出包
│   └── version.properties        版本号唯一真源
├── docs/                README 与 CHANGELOG 的副本（方便单独查阅/分发）
├── keystore/            deepsleep.keystore（签名密钥，务必备份）
├── release/             产物：Deepseek-API版-<版本>.apk
│   └── history/         历史版本留档
└── archive/             源码包、文档包、旧 zip
```

**关键约定**：`assets/web/` 是构建时生成的，不要手改；唯一的真源是 `Deepsleep/dist/`。

## 工具链与固定路径

| 组件 | 版本 | 路径 |
|---|---|---|
| Node | 22.x | `/usr/bin/node` |
| pnpm | 12.8.1 | `/usr/bin/pnpm` |
| JDK | 17 | `/usr/lib/jvm/java-17-openjdk-amd64` |
| Android SDK | platform 34 + build-tools 34.0.0 | `/home/ubuntu/android-sdk` |
| Gradle | 8.7（免 wrapper，直接调用） | `/home/ubuntu/gradle-8.7/bin/gradle` |
| 签名密钥 | CN=Deepsleep（密码不入库，自行设置） | `keystore/deepsleep.keystore`（不进仓库） |

`maven.google.com` 在这台机器上不通，`settings.gradle.kts` 里用的是 `maven.aliyun.com` 的 google 镜像；Gradle 发行版走腾讯云镜像。**换机器时这两个镜像地址要一起带过去。**

**Windows 本机（1.2.6 起）**：工具链装在 `C:\ds-toolchain`（Temurin/OpenJDK 17.0.2、Android SDK platform-34 + build-tools 34.0.0、Gradle 8.7），工程通过目录联接 `C:\ds-src` 访问——因为工作区路径里有中文（`自用软件`），aapt2 在非 ASCII 路径上不一定安分。出包用 `android/build-apk.ps1`，四个路径用环境变量传（脚本头注释里有完整命令）。`local.properties` 的 `sdk.dir` 是机器本地文件，本机已改成 `C:/ds-toolchain/android-sdk`，换回 Ubuntu 时要改回 `/home/ubuntu/android-sdk`。

## 从零重建（四条命令）

```bash
# 1. 前端依赖 + 构建
cd /home/ubuntu/Deepsleep
pnpm install
pnpm type && pnpm build          # 类型检查必须过，dist/ 更新

# 2. 打 APK（自动递增版本号、同步 assets、签名、导出到 /home/ubuntu/）
cd /home/ubuntu/DeepsleepStd
./build-apk.sh
```

出来的是 `/home/ubuntu/deepsleep/release/Deepseek-API版-<versionName>.apk`。

只改前端时也必须走 `build-apk.sh`——它负责把 `dist/` 拷进 `assets/web/`，跳过这步 APK 里还是旧界面。

## 相对上游的改动清单

### 前端（Deepsleep/）

| 文件 | 改动 | 为什么 |
|---|---|---|
| `src/services/chat/history/toLocal.ts` | 重写 `buildTree()`：沿 `current_message_id` 上溯，只取当前分支 | 官方导出会写出同角色兄弟节点（重新生成的会话），旧实现直接 `fail('backupInvalidBranches')` 整包失败 |
| `src/services/chat/history/importArchive.ts` | 单会话解析失败改为跳过并计数，不中断整包 | 一个坏会话不该让 85 个会话全导不进来 |
| `src/services/chat/backup.ts` | `importHistory(file, onProgress)`，先按字节读、再按会话报进度 | 6.9 MB 的包在手机上读流要好几秒，没有反馈像卡死 |
| `src/services/chat/search.ts` | 新增：全库检索（懒建索引 + 指纹失效） | 侧边栏搜索原来只匹配标题 |
| `src/services/chat/store.ts` | 新增 `forkSession()`、`pinSessions()`；`sortSessions` 置顶优先 | 对话分叉、批量置顶 |
| `src/services/pricing.ts` | 新增：按官方价格表算单条花费，含峰谷时段判断 | 每条回复显示 `¥0.00xx` |
| `src/services/api/balance.ts` | 新增：`GET /user/balance` | 设置页显示账户余额 |
| `src/components/chatInput/AttachSheet.tsx` | 新增：移动端底部抽屉（拍照/相册/文件） | 对齐官方 App 的上传交互 |
| `src/components/chatInput/ContextMeter.tsx` | 新增：输入框右侧的上下文用量环 | 对齐 DSH 的 ContextMeter |
| `src/components/sider/SearchOverlay.tsx` | 新增：全屏搜索页，`createPortal` 到 body | 放在抽屉里时 `position: fixed` 被抽屉的 transform 限制成半屏 |
| `src/components/sider/useEdgeSwipe.ts` | 新增：全屏右滑开抽屉、左滑收起、跟手位移 | 对齐官方手势 |
| `src/components/sider/Sider.tsx` | 批量管理模式（选择/置顶/删除）、搜索入口 | 对齐官方批量管理 |
| `src/components/messages/AssistantMessage.tsx` | 动作区加“分叉”和花费 | — |
| `src/components/markdown/*` | 表格/代码块加 `data-no-swipe` 与 `touch-action: pan-x` | 全屏滑动手势会吃掉页面内横向滚动 |
| `src/services/settings.ts`、`chat/db.ts` | 存储键前缀 `chat-demo:` → `deepsleep:`，IndexedDB 名同步 | 与官方 demo 同浏览器并存互不干扰 |
| `rspack.config.ts` | 构建目标 `chrome >= 80`；拷贝图标与 manifest | 原目标 chrome 105，Android 10 及更老的 WebView 直接语法报错白屏 |
| `src/services/chat/history/*` | 新增（1.2.6）：`zip.ts` 中央目录定位读、`archive.ts` 清单与附件表、`toLocal.ts` fragment→blocks、`importPipeline.ts` 按会话推进、`exportArchive.ts` 本地 v4 导出 | 资料包里这个目录曾经整个缺失，`backup.ts` 的引用是悬空的；导入重做后 372 MB 的包峰值从 727 MB 降到 217 MB |
| `src/services/chat/backup.ts` | `importHistory(file, options, onProgress)`：删掉整包 buffer，改为直接 `openHistoryArchive(file)` 后渐进写入 | 整包物化要 727 MB 常驻，发生在任何解析之前 |
| `src/services/chat/db.ts` | 新增 `beginHistoryReplace()` / `putHistorySession()`（附件 8 个一批事务），删 `updateStagingFileTypes()` | 写入从「暂存 + 单事务搬 450 MB」改成边解析边落盘；MIME 由 entry 名直接给出，不需要回填扫描 |
| `src/services/chat/store.ts` | 抽出 `runHistoryReplacement()`，新增 `replaceHistoryProgressively()` | 导入中断时列表要刷成库里的实际内容，不能继续显示已经删掉的旧记录 |
| `src/components/settings/SettingsDialog.tsx` | 导入确认框加「同时导入图片附件」，进度改按写入字节 | >128 MB 的包默认只导正文 |
| `tools/*.mjs` | 新增：`import-dryrun` / `pipeline-bench` / `roundtrip` / `baseline-bench` | 用真实归档在 Node 里复跑同一条链路；`tsconfig` 只 include `src`，不影响 `pnpm type` |
| `src/i18n/{zh,en}.ts` | 新增约 25 个文案键 | 新功能 |

### Android 工程（DeepsleepStd/）

| 文件 | 改动 | 为什么 |
|---|---|---|
| `MainActivity.java` | 本地 HTTP 服务（127.0.0.1:8731）把 assets 喂给 WebView | WebView 的 `file://` 源是 `null`，请求 api.deepseek.com 会被 CORS 拦，localStorage/IndexedDB 行为也不一致 |
| 同上 | `onShowFileChooser`：按 accept 形态区分 `image/*`（相册）与扩展名列表（文件），后者用 `*/*` | 把 `.pdf,.docx` 当 MIME 塞进 picker，文件管理器会过滤掉一切、显示空的“最近” |
| 同上 | `__deepsleepNative.takePhoto()` + `ACTION_IMAGE_CAPTURE` | WebView 的 `<input capture>` 在多数国产 ROM 上唤不起相机 |
| 同上 | `onCreateWindow` / `shouldOverrideUrlLoading` → 打开 `BrowserActivity` | 链接原来跑进对话用的 WebView，返回时 SPA 重载、activeId 丢失，落到“新对话”首页 |
| 同上 | `onPermissionRequest` 先补 Android 运行时权限再 grant | 拒绝过麦克风权限后，WebView 静默失败，看起来像“语音没反应” |
| `BrowserActivity.java` | 新增：独立 WebView 浏览页，带返回箭头与进度条 | 隔离状态，返回即 `finish()` |
| `AndroidManifest.xml` | `uses-sdk` min 21 / target 34；`allowBackup=false` + `dataExtractionRules` | 漏写 `uses-sdk` 时 aapt 把 target 当 1，安装器报“为旧版安卓打造” |
| `res/mipmap-*` | DS 官方鲸鱼 logo，5 档 | — |
| `build-apk.sh` | 版本号递增 + 构建 + 签名 + 导出 | 见下节 |
| `build-apk.ps1`（1.2.6） | 同上，Windows 版；工具链路径用 `DEEPSLEEP_JDK`/`DEEPSLEEP_SDK`/`DEEPSLEEP_GRADLE`/`DEEPSLEEP_KEYSTORE` 覆盖 | 本机是 Windows，`build-apk.sh` 里的绝对路径跑不了 |
| `app/build.gradle.kts`（1.2.6） | 签名密钥路径可用 `-Pdeepsleep.keystore=` 覆盖 | 原来写死 `/home/ubuntu/...`，换机器就签不了名 |

## 签名与版本号规则

**签名**：`keystore/deepsleep.keystore`（不进仓库），alias `deepsleep`；密码通过 `-Pdeepsleep.storePassword` / `-Pdeepsleep.keyPassword` 或环境变量传入，不入库。**这个文件丢了，以后所有更新都得让用户卸载重装，本地数据一并丢失。** 备份它。

**版本号**：`version.properties` 是唯一真源，`build-apk.sh` 每次构建前自动 +1，规则是**逐位进位、满 9 进一**：

```
1.0.8 → 1.0.9 → 1.1.0 → 1.1.1 → … → 1.1.9 → 1.2.0
1.9.9 → 2.0.0
```

`versionCode` 每次 +1，`versionName` 按上面进位。要抬大版本，直接改 `version.properties` 再构建。

**数据继承**：包名（`com.deepsleep.app`）+ 签名 + 本地 origin（`http://127.0.0.1:8731`）三者不变，覆盖安装后会话、API key、设置都在。**改端口等于换 origin，旧数据读不到。**

**跨版本实测（1.2.2 → 1.2.7）**：除上面三项，存储前缀 `deepsleep:` 与 IndexedDB 库名 `deepsleep` 从 1.0.0 起也没动过，库版本一直是 **11**、5 个 object store 无增删——所以两版之间**没有任何迁移**，记录原样可读。在 MuMu 上把 1.2.7 → 1.2.2 → 1.2.7 来回装过：364 MB 的库与 360 MB 的 blob 目录全程不变，`firstInstallTime` 也没变（证明是升级不是重装）。会丢数据的只有四种情况：换包名、换签名密钥、改本地服务端口、或从 1.0.0 之前那版（前缀还是 `chat-demo:`）直接升。

## 已知坑与排错

**`assets/web/` 没更新**：只跑了 `pnpm build` 没跑 `build-apk.sh`，APK 里还是旧界面。表现为“改了没生效”。

**`position: fixed` 在抽屉里失效**：抽屉容器带 `transform`，fixed 后代以它为准。全屏层必须 `createPortal` 到 `document.body`。

**CSS 规则被同名合并误删**：我清理重复选择器时误删过 `.selecting`，改完要 `grep -c '^\.选择器'` 数一下。

**`icons.tsx` 被整体覆盖**：早期我用整段替换的方式改这个文件，直接把它写成了别的组件。正确做法是**追加**新图标，不要 `s[:start] + new` 那种写法。

**aapt 报 targetSdkVersion < 4**：清单漏 `uses-sdk`，Gradle 工程里由 `defaultConfig` 注入，手工 `aapt2 link` 时必须自己写。

**手势与横向滚动打架**：`useEdgeSwipe` 会 `preventDefault` 横向移动。任何横向滚动容器都要么 `data-no-swipe`，要么满足 `overflow-x: auto` 且 `scrollWidth > clientWidth`（代码里有自动检测）。

**在 Android 上手动调试前端**：`adb logcat | grep chromium` 能看到 WebView 的 console 输出；`chrome://inspect` 需要桌面 Chrome 且端口转发，本机没有 GUI，用不了。

**大包导入的隐性口径**：超过 128 MB 的归档默认只导正文（图片在聊天里显示文件名）。这不是省事——303 MB 图片写进 IndexedDB 之后，打开一个带 273 张图的会话会在渲染层一次并发 273 次 blob 读（`MessageFile` 的 `useFileUrl` 无缓存、`MessageList` 无虚拟化），比导入更容易崩。导入峰值由**最大的单个会话**决定，与整包大小无关；实测 28.2 MB 的会话解析要 +55 MB 堆。

**导出的包不再与官方互通**：1.2.6 起导出是本地结构 `export_format_version: 4` + `sessions_format: local-v1`（往返无损），官方网页版和旧版 APK 会报「文件版本过新」。官方 v3 的包**照样能导入**。要恢复互通得把 `blocks` 反推成 `fragments`，见 `docs/PLAN-1.2.6.md` 第八节。

**`history/` 目录曾经整段缺失**：`backup.ts` 用动态 import 引 `./history/{importArchive,exportArchive}.js`、静态 re-export `./history/errors.js`，缺任何一个 `pnpm build` 都过不去。交接目录、`archive/deepsleep-src-1.2.5.zip`、最初的工作区快照里都没有这个目录，只有构建产物（`assets/web/static/js/async/925.ab271cc3.js` 是导入器、`5856.62dcb49b.js` 是导出器）。1.2.6 按产物反推的行为重写了这一层，`zipReader.ts` 对应新的 `zip.ts`。

**文档与产物不一致过一次，信产物**：`HANDOFF.md` 与 1.2.3（稳定线）的 CHANGELOG 都说导入是「全流式、opening/reading/writing 三段进度」，但 1.2.5 与 1.3.6 两个 APK 里的导入模块都没有 opening 阶段，调用方仍然把整包读成 chunk 数组再 `new File(chunks)`（`main` 里 431 KB 偏移附近）。改动导入前先解 APK 看 `assets/web/static/js/async/925.*.js` 与 `main.*.js`，别照着文档改。

## 跟进上游

上游仓库仍在更新（目前 `main` 上只有两个提交：初版 + 导入报错文案修正）。合并方式：

```bash
cd /tmp
curl -sL https://codeload.github.com/deepseek-ai/chat-demo/zip/refs/heads/main -o ds.zip
unzip -q ds.zip -d dsx
diff -ru dsx/chat-demo-main/src /home/ubuntu/deepsleep/frontend/src | less
```

`diff` 里左边是上游、右边是我们的版本，逐条判断要不要带过来。**注意别整目录覆盖**——那会冲掉 `README.DEEPSLEEP.md` 之外的所有改动（`toLocal.ts`、`importArchive.ts`、`store.ts` 都是重灾区）。

值得回馈上游的两处：`buildTree` 的分支容错、`importArchive` 的逐会话容错——官方导出产出的包，官方自己的导入器吃不下，属于上游 bug。

