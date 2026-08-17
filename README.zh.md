# DeepSeek Harness for VS Code

把 DeepSeek Harness 放到你真正写代码的地方。dsh-vscode 为 DSH 提供类似 Claude Code、Codex 的 VS Code 右侧边栏，并自动理解当前项目、文件和选区。

让 DeepSeek 直接阅读、修改和验证代码，不再需要在编辑器、终端和独立聊天窗口之间反复切换。

[English](README.md) | **简体中文**

[![CI](https://github.com/Lixxx1/dsh-vscode/actions/workflows/ci.yml/badge.svg)](https://github.com/Lixxx1/dsh-vscode/actions/workflows/ci.yml)
[![VS Code Marketplace](https://img.shields.io/visual-studio-marketplace/v/lixxx1.dsh-sidebar?style=flat-square&label=VS%20Code%20Marketplace&color=4d6bfe)](https://marketplace.visualstudio.com/items?itemName=lixxx1.dsh-sidebar)
[![MIT License](https://img.shields.io/badge/license-MIT-263146?style=flat-square)](LICENSE)
![Status](https://img.shields.io/badge/status-alpha-7da1de?style=flat-square)

<p align="center">
  <img src="media/demo.gif" alt="VS Code 侧边栏中的 DeepSeek Harness">
</p>

## 功能

- **使用真实的 DSH runtime。** 项目会话、流式回复、工具调用、操作审批、后续问题和官方 `/` 命令都可以在 VS Code 侧边栏中完成。
- **从正确的代码上下文开始。** DeepSeek 会获取当前工作区、正在查看的文件和选中代码；也可以通过 `@` 添加指定文件或文件夹，或使用 **Add Selection to Chat** 固定选区。
- **清楚控制每次会话。** 在输入框中切换 DSH 官方 Permission 和 Plan 模式，并分别选择 Model 与 Reasoning Effort。
- **在写代码的地方审阅改动。** Changed Files 按 Turn 分组并显示 `+/-` 行数，可使用 VS Code 原生 Diff Editor 查看，再对单个文件或全部改动执行 Keep 或安全 Revert。
- **在 DeepSeek 工作时保持控制。** 任务运行期间可以排队、编辑、删除或立即调整后续消息；如果 DeepSeek 即将修改包含未保存内容的文件，任务会在覆盖前停止。

## 安装

先安装官方 DeepSeek Harness CLI：

```sh
npm install -g @deepseek-ai/dsh
```

然后在 VS Code 中打开**扩展**，搜索 **DSH Sidebar** 并点击**安装**；也可以直接从 [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=lixxx1.dsh-sidebar) 安装。

需要 VS Code 1.100 或更新版本，以及 Node.js `^22.19` 或 `>=24`。

## 使用

1. 在 VS Code 中打开一个受信任的项目文件夹。
2. 在右侧选择 **DeepSeek Harness**。如果没有显示，可以在 **其他视图** 中找到它。
3. 点击钥匙按钮配置 `DEEPSEEK_API_KEY`。
4. 选择 Permission 模式、Model 和 Reasoning Effort，然后开始工作。Shield 菜单用于切换 Permission 和 Plan 模式，输入 `/` 使用 DSH 官方命令，输入 `@` 添加文件或文件夹。

## License

[MIT](LICENSE)
