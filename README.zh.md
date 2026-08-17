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

- 在 VS Code 右侧边栏中提供 Claude Code、Codex 风格的 DeepSeek Harness 编码体验，让助手始终常驻代码旁边。
- 默认围绕项目工作：DeepSeek 直接在选中的 VS Code 工作区中运行，也可以从输入框快速切换项目。
- 无需离开编辑器即可完成完整的编码流程，包括流式回复、工具调用、操作审批和后续问题。
- 在侧边栏中管理项目会话，分别选择 Model 与 Reasoning Effort，并使用 DSH 官方 `/` 命令。

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
4. 选择项目、会话、Model 和 Reasoning Effort，然后开始工作。输入 `/` 可以打开 DeepSeek Harness 命令菜单。

实现细节见[架构文档](docs/architecture.md)。参与开发前请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。

## License

[MIT](LICENSE)
