# Deepsleep

[![CI](https://github.com/wuhedaoshi/deepsleep/actions/workflows/ci.yml/badge.svg)](https://github.com/wuhedaoshi/deepsleep/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

一个跑在 Android WebView 里的 DeepSeek 聊天客户端。前端基于官方
[chat-demo](https://github.com/deepseek-ai/DeepSeek-Chat-Demo)（MIT）二次开发，
后端就是 DeepSeek 的 Anthropic 兼容接口——没有自建服务，没有中转。

<img src="docs/img/phone-chat.png" width="320" alt="手机上的 Deepsleep">

## 两条线

| 线 | 版本 | 说明 |
|---|---|---|
| **稳定线** | `1.2.9` | 贴近原版 DeepSeek App：只保留官方格式导入导出、大包导入、本地历史，不含魔改功能。**推荐先装这个。** |
| **实验线** | `1.3.9` | 在稳定线基础上加上下文压缩（自动 + `/compact`）等魔改，行为可能继续调整。 |

两条线共用同一个包名与签名（`com.deepsleep.app`），可以互相覆盖安装、数据自动继承；
`versionCode` 只能往上走，从实验线回稳定线需要装更高号的稳定线包。
## 它能做什么

| 能力 | 说明 |
|---|---|
| 完整对话历史在本地 | IndexedDB 存储，图片原件一起落盘；换机时导出 ZIP 带走 |
| **兼容官方导出格式** | 导出的是官方 `export_format_version: 3` 归档，网页版与官方客户端可直接导入；也能导入它们的导出 |
| 大包导入 | 300 MB+ / 上千条图片的归档按会话渐进写入，中断后已导入的部分仍可用 |
| 上下文压缩 | 照 DeepSeek Harness 官方压缩机制：接近窗口上限时把较早的历史摘要成结构化 checkpoint，近期逐字保留；也支持手动（点用量环或发 `/compact`） |
| 深色 / 多语言 / 语音朗读 | 跟随系统主题，简体中文与英文，Web Speech + 服务端 TTS |

## 目录

```
deepsleep/
├── frontend/          React + rspack 前端（chat-demo 二次开发）
│   ├── src/           源码；services/chat/history/ 是导出导入的核心
│   └── tools/         Node 侧脚本：导入试跑、往返比对、压缩与排版的断言
├── android/           Android 工程（WebView 壳 + 本地 HTTP 服务）
│   ├── app/           MainActivity、原生桥（SAF 落盘）、Gradle 配置
│   └── build-apk.*    一条命令出包，自动递增 versionCode / versionName
├── docs/              维护手册、CHANGELOG、设计与移植笔记
└── release/           本地打好的 APK（不进仓库，用 Releases 分发）
```

## 构建

需要 JDK 17、Android SDK（platform-34 / build-tools 34.0.0）、Gradle 8.7、Node 20+、pnpm。

```bash
# 1) 前端
cd frontend
pnpm install
pnpm build            # 产出 dist/，随后由 Android 工程打进 assets/web

# 2) Android（自备签名，见下）
cd ../android
DEEPSLEEP_JDK=/path/to/jdk-17 \
DEEPSLEEP_SDK=/path/to/android-sdk \
DEEPSLEEP_GRADLE=/path/to/gradle-8.7/bin/gradle \
./build-apk.sh
# Windows: pwsh -File .\build-apk.ps1
```

**签名**：仓库里没有 keystore。自己生成一个，通过 `-Pdeepsleep.keystore`（以及
`-Pdeepsleep.storePassword` / `-Pdeepsleep.keyPassword`）传进去：

```bash
keytool -genkeypair -keystore keystore/deepsleep.keystore -alias deepsleep \
        -keyalg RSA -keysize 2048 -validity 10000
```

**版本号**：`android/version.properties` 是唯一真源，构建脚本每次 +1（`versionCode` 单调递增，
Android 靠它判升级；`versionName` 独立，可定回任意版本）。

## 技术要点

- **WebView 壳**：`MainActivity` 在 `127.0.0.1:8731` 起一个本地 HTTP 服务，静态资源来自
  `assets/web`，页面脚本经 `addJavascriptInterface` 拿到原生能力（选文件、保存到 SAF、相机、语音）。
- **流式 ZIP**：自己解析中央目录，按块解压/写入；导出经原生 SAF 直接落盘，不在内存里拼整包
  （450 MB 的归档在手机上这么干必然 OOM）。
- **上下文压缩**：阈值 `floor(min(W×0.8, W−O−B))`、逐字保留 `(W−O)×0.16`，摘要提示词沿用
  8 段结构化 checkpoint；压缩指令作为最后一条 user 消息追加，复用 provider 的前缀缓存。

细节都在 [`docs/`](docs)：[`CHANGELOG.md`](docs/CHANGELOG.md)（1.0 起全部改动与原因）、
[`README.DEEPSLEEP.md`](docs/README.DEEPSLEEP.md)（工具链与已知坑）、
[`PLAN-1.3.8-COMPACTION.md`](docs/PLAN-1.3.8-COMPACTION.md)（压缩设计）。

## 免责声明

非官方客户端，与 DeepSeek 无隶属关系。使用需要自备 API Key，调用量与费用由你的账号承担。
请遵守 DeepSeek 的服务条款；导出的归档里有你的完整对话与图片，分享前自己脱敏。

## License

MIT。前端来自官方 chat-demo（Copyright © 2026 DeepSeek），修改部分归 Deepsleep contributors。
