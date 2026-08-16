# DeepSeek Harness for VS Code

在 VS Code 侧边栏中使用 DeepSeek Harness 编码助手。

目标是提供和 Claude Code、Codex 的 VS Code 版本相同类型的使用体验：编码时让助手常驻编辑器旁边，并自动围绕当前项目工作。

[English](README.md) | **简体中文**

[![CI](https://github.com/Lixxx1/dsh-vscode/actions/workflows/ci.yml/badge.svg)](https://github.com/Lixxx1/dsh-vscode/actions/workflows/ci.yml)
[![MIT License](https://img.shields.io/badge/license-MIT-263146?style=flat-square)](LICENSE)
![Status](https://img.shields.io/badge/status-alpha-7da1de?style=flat-square)

<p align="center">
  <img src="media/demo.gif" alt="VS Code 侧边栏中的 DeepSeek Harness">
</p>

## 功能

- 围绕 VS Code 当前打开的项目与 DeepSeek 对话。
- 编码时让助手常驻右侧侧边栏。
- 创建新对话，或继续已有的项目会话。
- 分别选择 Model 和 Reasoning Effort。
- 直接在编辑器中查看流式 Markdown 回复和可展开的工具卡片。
- 在会话中处理工具审批，并回答 DeepSeek 的后续问题。
- 为提示词添加图片附件，并直接停止正在运行的任务。
- 需要更大空间时，在编辑器 Tab 中打开同一个对话。

## 安装

先安装官方 DeepSeek Harness CLI：

```sh
npm install -g @deepseek-ai/dsh
```

然后构建并安装扩展：

```sh
git clone https://github.com/Lixxx1/dsh-vscode.git
cd dsh-vscode
corepack pnpm install --frozen-lockfile
corepack pnpm run check
corepack pnpm run package
code --install-extension dsh-vscode.vsix
```

需要 VS Code 1.100 或更新版本，以及 Node.js `^22.19` 或 `>=24`。

## 使用

1. 在 VS Code 中打开一个受信任的项目文件夹。
2. 在右侧选择 **DeepSeek Harness**。如果没有显示，可以在 **其他视图** 中找到它。
3. 点击钥匙按钮配置 `DEEPSEEK_API_KEY`。
4. 选择会话、Model 和 Reasoning Effort，然后开始工作。

实现细节见[架构文档](docs/architecture.md)。参与开发前请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。

## License

[MIT](LICENSE)
