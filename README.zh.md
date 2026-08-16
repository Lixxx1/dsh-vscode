<p align="center">
  <strong>DeepSeek Harness for VS Code</strong>
</p>

<p align="center">
  <a href="README.md">English</a> | <strong>简体中文</strong>
</p>

<p align="center">
  <a href="https://github.com/Lixxx1/dsh-vscode/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/Lixxx1/dsh-vscode/actions/workflows/ci.yml/badge.svg"></a>
  <a href="LICENSE"><img alt="MIT License" src="https://img.shields.io/badge/license-MIT-263146?style=flat-square"></a>
  <img alt="Status" src="https://img.shields.io/badge/status-alpha-7da1de?style=flat-square">
  <img alt="VS Code" src="https://img.shields.io/badge/VS%20Code-%3E%3D%201.100-4b6fff?style=flat-square">
</p>

# dsh-vscode

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 VS Code 侧边栏扩展。它把真实的官方 `dsh web` Cordis profile 作为子进程启动，并在 VS Code 内承载官方 DSH 客户端。

项目不包含 mock 运行时、不复制 agent loop，也不另造一套会话协议。会话、流式输出、工具卡片、审批、用户提问、模型选择、持久化和权限策略继续由 DeepSeek Harness 负责。

> [!IMPORTANT]
> 这是早期社区扩展，不是 DeepSeek 官方产品。DeepSeek Harness 仍在快速开发中，兼容版本和接入细节可能变化。

## 核心能力

| 能力 | 行为 |
|---|---|
| Activity Bar 对话 | 在 VS Code 侧边栏打开官方响应式 DSH 客户端 |
| 真实 DSH 运行时 | 启动 `dsh web --host 127.0.0.1 --port 0`，没有模拟后端 |
| 多界面复用 | 侧边栏、编辑器 Tab 和浏览器共用一个子进程 |
| 官方交互链路 | 工具展示、审批、提问、模型、队列和会话回放全部来自 DSH |
| Workspace 归属 | 以第一个 VS Code workspace folder 作为 DSH 工作目录 |
| 生命周期 | 启动超时、运行日志、重启、SIGTERM 关闭与最终强制终止 |
| Remote 支持 | 通过 `vscode.env.asExternalUri` 支持 Remote SSH、Dev Container 和端口转发 |

## 工作方式

```text
VS Code Extension Host
  ├─ 启动：dsh web --host 127.0.0.1 --port 0
  ├─ 读取官方 "dsh web: http://127.0.0.1:<port>" 公告
  └─ 在受信任 workspace 的 Webview 中嵌入解析后的地址

VS Code Webview
  └─ 官方 DSH Web 客户端
       └─ API Proxy HTTP/WebSocket carrier
            └─ Cordis services → Agents → 会话/工具/审批/持久化
```

扩展只是进程和界面适配层，不解释模型事件，也不自行做权限决定。所有权和安全边界见[架构文档](docs/architecture.md)。

## 前置条件

- VS Code 1.100 或更新版本。
- Node.js `^22.19` 或 `>=24`。
- 已安装并配置官方 `dsh` CLI。
- 发送真实 prompt 时需要 `DEEPSEEK_API_KEY` 等模型凭证。

安装官方 CLI，并先确认 Web profile 能启动：

```sh
npm install -g @deepseek-ai/dsh
dsh web --host 127.0.0.1 --port 0
```

## 从源码安装

首个版本先提供源码安装，之后再准备 VS Marketplace 发布：

```sh
git clone https://github.com/Lixxx1/dsh-vscode.git
cd dsh-vscode
corepack pnpm install --frozen-lockfile
corepack pnpm run build
corepack pnpm run package
code --install-extension dsh-vscode.vsix
```

重载 VS Code，打开受信任的文件夹，再点击 Activity Bar 中的 DeepSeek 鲸鱼图标。第一次打开侧边栏时会自动启动 DSH。

开发扩展时，直接用 VS Code 打开本仓库并按 `F5`；随仓库提供的 Extension Development Host 配置会先执行构建。

## 配置

| 设置 | 默认值 | 用途 |
|---|---|---|
| `deepseekHarness.executable` | 空 | 指定 DSH 可执行文件；空值从 `PATH` 使用 `dsh` |
| `deepseekHarness.arguments` | `web --host 127.0.0.1 --port 0` | 传给 DSH 的参数 |
| `deepseekHarness.autoStart` | `true` | 打开侧边栏时启动 |
| `deepseekHarness.startupTimeout` | `60000` | 启动超时，单位毫秒 |

如果从 GUI 启动的 VS Code 看不到 shell 安装的 `dsh`，请配置绝对路径：

```json
{
  "deepseekHarness.executable": "/opt/homebrew/bin/dsh"
}
```

### 在侧边栏配置 API Key

VS Code 会把编辑快捷键交给外层 Webview，因此 `Cmd/Ctrl+V` 无法继续传到嵌套的官方 DSH iframe 密码输入框。点击视图标题栏的钥匙图标，或从命令面板运行 **DeepSeek Harness: Configure API Key**。VS Code 原生密码输入框支持粘贴；密钥保存在 VS Code SecretStorage 中，只会作为 `DEEPSEEK_API_KEY` 传给官方 DSH 子进程。运行 **DeepSeek Harness: Clear Stored API Key** 可删除它。

## 命令

- `DeepSeek Harness: Open Chat in Editor`
- `DeepSeek Harness: Restart Runtime`
- `DeepSeek Harness: Show Runtime Output`
- `DeepSeek Harness: Open in Browser`
- `DeepSeek Harness: Configure API Key`
- `DeepSeek Harness: Clear Stored API Key`

## 开发

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm run typecheck
corepack pnpm run test
corepack pnpm run build
corepack pnpm run package
```

测试覆盖启动解析和官方 loopback URL 公告格式。产品代码没有 mock DSH 模式。真实无 prompt 冒烟测试应启动官方 Web profile、请求 `/` 并验证干净关闭；发送模型 prompt 属于需要凭证的集成测试。

提交变更前请阅读[贡献指南](CONTRIBUTING.md)。

## 安全性

- DSH 可以运行命令和编辑文件，因此扩展在不受信任的 workspace 中禁用。
- 默认服务器只绑定 `127.0.0.1`，并使用操作系统分配的端口。
- 只接受官方固定格式的 loopback URL 公告用于嵌入。
- 凭证由 DSH 子进程继承；扩展不读取凭证值，也不通过 Webview 消息转发凭证。
- 沙箱和审批行为来自所选官方 DSH profile。在敏感仓库中使用前请检查该 profile。

安全问题请按 [SECURITY.md](SECURITY.md) 报告。

## 已知限制

- 首版嵌入官方响应式 Web 客户端，还没有 VS Code 原生消息 renderer。
- 多根 workspace 中，一个 Extension Host 当前使用第一个 workspace folder。
- DSH 需要单独安装，并且必须能被 Extension Host 找到。
- 尚未配置 Marketplace 发布和签名 Release。

## License

[MIT](LICENSE)
