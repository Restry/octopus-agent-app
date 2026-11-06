# Octopus 章鱼

透明桌面章鱼助手，使用本机 Node 后端管理模型凭据、MCP 连接、会话与记忆。当前发行版本 0.2.0 是首个带官方 Tauri 2 自动更新的版本。

## 安装

已构建平台：macOS Apple Silicon（arm64）。Intel macOS、Windows、Linux 尚未验证，不提供这些平台的安装包。

从本仓库 Releases 下载 `Octopus_0.2.0_aarch64.dmg`，打开后将 Octopus 拖入 Applications。也可解压 `Octopus_0.2.0_aarch64.app.tar.gz` 后将 `Octopus.app` 移入 Applications。运行时内嵌 Node，无需另行安装 Node。发行附件提供 `SHA256SUMS`、更新签名和构建来源。

当前本机构建使用 ad-hoc 签名，未使用 Apple Developer ID 签名或 Apple 公证。macOS 可能要求在系统设置“隐私与安全性”中确认打开可信下载。更新签名用于应用内部校验，不能代替 Apple 身份签名或公证。请确认发布者、下载来源与校验和。

点击章鱼脑袋展开聊天；聊天标题或“更多 → 高级设置”可配置模型。

## 模型配置

端点须为公开 HTTPS 域名，路径为 `/v1` 或 `/openai/v1`，并支持 OpenAI Responses API。高级设置填写端点、模型和密钥引用，确认向该端点发送对话与工具结果。模型列表由该端点的 `/models` 获取。

默认数据目录为 `~/Library/Application Support/Octopus`，可用后端环境变量 `OCTOPUS_DATA_DIR` 覆盖。在该目录创建权限为 `600` 的普通文件 `model-api-key`，将模型密钥写入文件，在设置中使用引用 `file/model-api-key`。不要把模型密钥放进聊天、仓库、前端或发行包。模型配置 `model.json` 也必须为权限 `600` 的普通文件。

也可从终端启动应用，并在启动环境设置：

```sh
export OCTOPUS_MODEL_BASE_URL=https://api.openai.com/v1
export OCTOPUS_MODEL=gpt-4.1-mini
# 通过本机受保护的方式设置 OCTOPUS_API_KEY 或 OPENAI_API_KEY。
/Applications/Octopus.app/Contents/MacOS/octopus-desktop
```

设置 `OCTOPUS_MODEL_BASE_URL` 后，环境变量优先且界面配置只读。仅使用环境变量密钥引用时，也可在设置中填写 `env/OPENAI_API_KEY`。Finder 启动的应用通常不继承 shell 环境，推荐使用本机文件。缺少密钥或权限过宽会给出明确提示。

`OCTOPUS_MODEL_CONFIG` 可指定本机配置文件。旧的 `~/.vault/menshen-agent.json` 仅在新配置不存在时作为已授权本机兼容引用读取；不会自动创建私人 vault 配置。只有旧配置显式包含 vault 引用时才调用原本机 CLI，公开版不要求安装该 CLI。

## MCP 和技能

可在聊天中明确请求安装 Streamable HTTP MCP，并附 `mcpServers` JSON；或安装纯文本 SKILL.md。仅支持明确的 HTTP MCP 连接，不执行 stdio 安装命令或任意安装脚本。认证只在后端保存到本机权限 `600` 的配置；不会作为模型可见参数持久化。安装后的能力用于新会话。

全新安装没有预置个人 MCP 凭据。已有本机门神或 mem0 配置仅作为可选本机引用读取，不随安装包分发。无已配置 MCP 时可正常使用已配置的模型聊天。

## 更新

桌面启动 15 秒后检查更新，每 6 小时再检查。聊天“更多 → 软件更新”及高级设置可手动检查、下载并查看进度。下载完成且签名校验通过后显示安装就绪；用户点击“安装更新并重启”才会安装与重启。后端运行任务时禁止安装，下载可继续。

旧版若未内置 updater，需要先手动下载安装 0.2.0 一次，此后才能使用应用内更新。

固定更新源：`https://github.com/Restry/octopus-agent-app/releases/latest/download/latest.json`。仅支持已实际构建的 `darwin-aarch64`。私钥丢失将导致现有安装无法信任后续签名，必须安全备份。

## 从源码构建和发行

需要 Node 22+、Rust stable、Xcode Command Line Tools。本机仅验证 macOS arm64。

```sh
npm ci --ignore-scripts
npm test
npm run build
npm run desktop:build
```

构建脚本将明确输出源码目录、版本及架构，并以白名单复制运行文件，在独立 staging 目录安装生产依赖，内嵌当前 Node。不会复制个人模型配置、MCP token、会话或记忆。默认生成 app、dmg 和签名 updater archive；可用 `OCTOPUS_BUNDLES=app` 仅生成 app/archive。

构建要求 `TAURI_SIGNING_PRIVATE_KEY`（私钥文件路径或内容）与 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`。本机默认读取专用 `~/.config/octopus-agent-app/updater/release.key`，密码为空；使用显式私钥时必须显式设置对应密码（无密码则为空字符串）。不会自动生成或复用其他项目密钥。公钥已固定在 Tauri 配置中，必须与私钥匹配。构建前记录白名单源码 SHA256 清单与 Git commit 时间，打包后复核源码未变化；`build-source.json` 的 `source` 是本地基准提交，`sourceHash` 标识实际构建快照，与公开仓库首次提交可能不同。运行 `npm run release:assets` 将已捕获来源的实际构建资产汇集到 `release/0.2.0/`，生成使用该提交固定时间的 `latest.json`、`SHA256SUMS` 和 `build-source.json`。

后续推送与版本一致的 `v*` 标签会触发 `.github/workflows/release.yml`。在仓库 secrets 中配置以上两个签名变量；只构建 macOS arm64，并创建 draft release。发布负责人收齐和验证资产、确认下述许可后再公开，之后复验公网更新源。

## 来源与许可前置条件

`vendor/personal-agent-core-0.4.0.tgz` 原样包含 `@personal-agent/core` 的源码、README 与契约。其 package.json 标记 `private: true`，压缩包没有 LICENSE 或 license 字段。本项目没有替该核心授予新的开源许可证；公开源代码和二进制分发前，发布负责人必须确认作者授权并补齐原作者许可。其他依赖的原始许可证随生产依赖保留。不要将此本地仓库的既有历史直接推送公开仓库：历史含个人来源路径及旧模型服务配置，应使用经过审查的干净 snapshot 建立公开初始提交。
