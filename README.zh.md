# DeepSeek Harness for VS Code 🐋

把 DeepSeek Harness 放到你真正写代码的地方。dsh-vscode 为 DSH 提供类似 Claude Code、Codex 的 VS Code 右侧边栏，并自动理解当前项目、文件和选区。

让 DeepSeek 直接阅读、修改和验证代码，不再需要在编辑器、终端和独立聊天窗口之间反复切换。

👋 我做这个插件，是因为自己也想让 DSH 一直待在编辑器旁边。如果这也是你喜欢的工作方式，欢迎试试看！也欢迎告诉我它用起来怎么样。

[English](README.md) | **简体中文**

[项目主页](https://lixxx1.github.io/dsh-vscode/) · [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=lixxx1.dsh-sidebar)

[![CI](https://github.com/Lixxx1/dsh-vscode/actions/workflows/ci.yml/badge.svg)](https://github.com/Lixxx1/dsh-vscode/actions/workflows/ci.yml)
[![VS Code Marketplace](https://img.shields.io/visual-studio-marketplace/v/lixxx1.dsh-sidebar?style=flat-square&label=VS%20Code%20Marketplace&color=4d6bfe)](https://marketplace.visualstudio.com/items?itemName=lixxx1.dsh-sidebar)
[![MIT License](https://img.shields.io/badge/license-MIT-263146?style=flat-square)](LICENSE)
![Status](https://img.shields.io/badge/status-alpha-7da1de?style=flat-square)

<p align="center">
  <img src="media/demo.gif" alt="VS Code 侧边栏中的 DeepSeek Harness">
</p>

## ✨ 功能

- **在 VS Code 中使用官方 DSH。** 会话、流式回复、工具调用、审批和追问都通过官方 DSH runtime 运行。
- **自动结合编辑器上下文。** 当前文件、选中的代码以及 `@file`、`@folder` 引用会随消息一起发送。
- **随时控制运行中的任务。** 切换 Permission 和 Plan 模式，分别选择模型和推理强度，也可以在任务运行时调整方向。
- **原生改动审阅与安全回退。** 在 VS Code Diff Editor 中检查改动，执行 Keep 或 Revert；遇到未保存文件时，会在覆盖前停止任务。
- **直接在侧边栏扩展 DSH。** 查找和管理 Tools、Skills、MCP、Memory 与 Agent Hooks，并交给 DSH 加载。

## 📦 安装

先安装官方 DeepSeek Harness CLI：

```sh
npm install -g @deepseek-ai/dsh
```

然后根据需要选择扩展版本：

### 发布版

在 VS Code 中打开**扩展**，搜索 **DSH Sidebar** 并点击**安装**；也可以直接从 [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=lixxx1.dsh-sidebar) 安装。

### 最新开发版

如果想提前使用已经合并到 `main`、但尚未发布到 Marketplace 的功能，可以构建并安装最新 VSIX：

```sh
git clone https://github.com/Lixxx1/dsh-vscode.git
cd dsh-vscode
pnpm install --frozen-lockfile
pnpm run package
```

然后在 VS Code 命令面板中运行 **Extensions: Install from VSIX...**，选择生成的 `dsh-vscode.vsix`。开发版更新更快，稳定性可能不如 Marketplace 版本；之后拉取最新代码并重新构建 VSIX 即可更新。

需要 VS Code 1.100 或更新版本，以及 Node.js `^22.19` 或 `>=24`。

安装社区 runtime 插件还需要确保 `pnpm` 已加入 PATH。

## 🚀 使用

1. 在 VS Code 中打开一个受信任的项目文件夹。
2. 在右侧选择 **DeepSeek Harness**。如果没有显示，可以在 **其他视图** 中找到它。
3. 点击钥匙按钮配置 `DEEPSEEK_API_KEY`。
4. 选择 Permission 模式、Model 和 Reasoning Effort，然后开始工作。Shield 菜单用于切换 Permission 和 Plan 模式，输入 `/` 使用 DSH 官方命令，输入 `@` 添加文件或文件夹。
5. 点击侧边栏标题栏中的插件按钮，搜索、安装、查看或移除社区 runtime 插件。

💬 如果哪里用着不顺手，或者你有想加的功能，欢迎来 [Issue](https://github.com/Lixxx1/dsh-vscode/issues) 里聊聊，也欢迎直接提 PR！

## License

[MIT](LICENSE)
