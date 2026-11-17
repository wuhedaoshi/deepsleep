# 开发资料包 · v1.2.5（2026-11-16）

Deepseek-API版：基于官方 chat-demo（MIT, commit 5d5dd75）二次开发的 Android 聊天客户端。

## 目录

```
deepsleep/
├── README.md                 根目录导航
├── docs/
│   ├── README.DEEPSLEEP.md   维护手册：工具链、改动清单、已知坑、跟上游
│   ├── CHANGELOG.md          1.0 → 1.2.5 全部改动与原因
│   └── RELEASE.md            产物目录说明
├── frontend/                 前端源码（官方 0.1.1 + 我们的改动）
└── android/                  Android 工程 + build-apk.sh + version.properties
```

## 未打包的内容

| 缺失 | 原因 | 怎么补 |
|---|---|---|
| `node_modules/` | 280 MB，可重建 | `cd frontend && pnpm install` |
| `dist/` `build/` `.gradle/` | 构建产物 | `pnpm build` / `./build-apk.sh` |
| `keystore/deepsleep.keystore` | 签名密钥，不随源码分发 | 单独保管，缺失则无法覆盖升级 |
| `release/*.apk` | 安装包单独发 | — |

## 重建

```bash
cd frontend && pnpm install && pnpm type && pnpm build
mkdir -p ../keystore && cp <deepsleep.keystore> ../keystore/
cd ../android && ./build-apk.sh
```

环境：Node 22 / pnpm / JDK 17 / Android SDK 34 / Gradle 8.7。
`settings.gradle.kts` 用阿里云 maven 镜像（本机 `maven.google.com` 不通）。

## 版本号

`android/version.properties` 为唯一真源，`build-apk.sh` 每次 +1，满 9 进一。

## 对照官方

官方未改动版另见 `chat-demo-official-0.1.1-5d5dd75.zip`：`diff -ru chat-demo-main/src frontend/src`
