# 参与开发

## 分支与提交

- `main` 始终可发布：能构建、能装机。改完直接推 `main` 也行，改动大就开分支。
- 分支命名：`feat/<一句话>`、`fix/<一句话>`、`docs/<一句话>`。
- 提交信息用 Conventional Commits 前缀，正文写**为什么**，不要复述 diff：

  ```
  fix(history): 图片 id 解析改成惰性匹配

  贪婪的 ([^/]+) 会回溯到文件名里最后一个下划线，把 IMG_2026… 一起吞进 id，
  写进库的键就成了 fid_文件名，而摘要引用的是 fid，孤儿清理随即把它们全删掉。
  ```

- 一次提交只做一件事。格式化、重命名这类噪音改动单独一次提交，别和逻辑改动混在一起。

## 提交前跑这些

```bash
cd frontend
pnpm type          # tsc --noEmit
pnpm lint          # oxlint，0 error 才算过
pnpm build         # 生产构建必须能出 dist/
```

改到 Android 侧或原生桥：

```bash
cd android
./gradlew :app:assembleDebug      # 没有签名材料也能过；release 会打未签名包
```

> wrapper 首次会下载 Gradle 8.7。网络受限时直接用本机的 Gradle 8.7：
> `DEEPSLEEP_GRADLE=/path/to/gradle ./build-apk.sh`（脚本优先用环境变量，其次 wrapper）。

改了导入导出或压缩逻辑，额外跑仓库里现成的断言脚本（它们用 `fake-indexeddb` 起真库、
用本地 mock 顶替模型接口）：

```bash
cd frontend
node --experimental-transform-types --import ./tools/run-ts.mjs tools/idb-probe.mjs <归档.zip>
node --experimental-transform-types --import ./tools/run-ts.mjs tools/compaction-e2e.mjs
```

## 代码约定

- 注释写**为什么**，不写「把值赋给变量」这种废话。中文注释，与现有代码一致。
- TypeScript 严格模式；不用 `any`；`console` 只在明确加了 `eslint-disable-next-line no-console`
  的地方出现（APK 里没有 devtools，日志是唯一观测手段）。
- 引用 `.ts` 文件时 import 写 `.js` 后缀（Node ESM + rspack 的约定）。
- 前端不引入运行时依赖除非必要：现有包已经覆盖 markdown、公式、代码高亮。

## 发布

1. `android/version.properties` 是版本号唯一真源；构建脚本每次 +1（`versionCode` 单调，`versionName` 可定回）。
2. 打 tag 并挂 Release：

   ```bash
   gh release create vX.Y.Z release/Deepsleep-X.Y.Z.apk --title "vX.Y.Z · 一句话" --notes-file - 
   ```

3. `docs/CHANGELOG.md` 同步写一节：改了什么、**为什么**、怎么验证的、还有什么没验证。

## 不要提交

`keystore/`、`android/local.properties`、`release/*.apk`、`frontend/dist`、
`android/app/src/main/assets/web`（构建期同步）、`node_modules`。`.gitignore` 已覆盖，
提交前 `git status` 扫一眼。
