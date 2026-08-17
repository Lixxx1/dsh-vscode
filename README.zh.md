# DeepSeek Harness for VS Code

在 VS Code 侧边栏中使用 DeepSeek Harness 编码助手。

目标是提供和 Claude Code、Codex 的 VS Code 版本相同类型的使用体验：编码时让助手常驻编辑器旁边，并自动理解当前项目、文件和选区。

[English](README.md) | **简体中文**

[![CI](https://github.com/Lixxx1/dsh-vscode/actions/workflows/ci.yml/badge.svg)](https://github.com/Lixxx1/dsh-vscode/actions/workflows/ci.yml)
[![MIT License](https://img.shields.io/badge/license-MIT-263146?style=flat-square)](LICENSE)
![Status](https://img.shields.io/badge/status-alpha-7da1de?style=flat-square)

<p align="center">
  <img src="media/demo.gif" alt="VS Code 侧边栏中的 DeepSeek Harness">
</p>

## 功能

- 在 VS Code 右侧边栏中提供 Claude Code、Codex 风格的编码助手，并由官方 DeepSeek Harness runtime 驱动。
- 内置项目与编辑器上下文：DeepSeek 可以获取当前工作区、正在查看的文件和选中代码，也支持通过 `@file`、`@folder` 或 **Add Selection to Chat** 主动添加上下文。
- 原生代码审阅：点击文件引用和工具结果即可跳转到编辑器，并使用 VS Code Diff Editor 检查单个文件或全部改动。
- 安全处理未保存代码：如果 DeepSeek 即将修改一个包含未保存内容的文件，任务会在覆盖前停止并提示冲突。
- 无需离开编辑器即可完成流式回复、工具调用、操作审批、后续问题、项目会话和 DSH 官方 `/` 命令等完整流程。
- 任务运行时可以继续排队消息，编辑或删除队列内容，也可以按 `Cmd/Ctrl+Enter` 立即调整当前任务。
- 在输入框中分别选择 Model 和 Reasoning Effort。

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
4. 选择项目、会话、Model 和 Reasoning Effort，然后开始工作。输入 `/` 使用 DSH 官方命令，输入 `@` 添加文件或文件夹。

## License

[MIT](LICENSE)
