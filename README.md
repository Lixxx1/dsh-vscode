# DeepSeek Harness for VS Code 🐋

> [!NOTE]
> ⭐ Like DSH Sidebar? [Give it a Star on GitHub](https://github.com/Lixxx1/dsh-vscode)! It helps more people find the project.

Bring DeepSeek Harness into the same place you write code. dsh-vscode gives DSH a Claude Code/Codex-style right sidebar that already understands your project, active file, and selected code.

Ask DeepSeek to inspect, change, and verify code without switching between your editor, terminal, and a separate chat window.

👋 I built this because I wanted DSH right beside my editor. If that sounds useful to you too, give it a try! I'd love to hear how it fits into your workflow.

**English** | [简体中文](README.zh.md)

[Website](https://lixxx1.github.io/dsh-vscode/) · [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=lixxx1.dsh-sidebar)

[![CI](https://github.com/Lixxx1/dsh-vscode/actions/workflows/ci.yml/badge.svg)](https://github.com/Lixxx1/dsh-vscode/actions/workflows/ci.yml)
[![VS Code Marketplace](https://img.shields.io/visual-studio-marketplace/v/lixxx1.dsh-sidebar?style=flat-square&label=VS%20Code%20Marketplace&color=4d6bfe)](https://marketplace.visualstudio.com/items?itemName=lixxx1.dsh-sidebar)
[![MIT License](https://img.shields.io/badge/license-MIT-263146?style=flat-square)](LICENSE)
![Status](https://img.shields.io/badge/status-alpha-7da1de?style=flat-square)

<p align="center">
  <img src="media/demo.gif" alt="DeepSeek Harness in the VS Code sidebar">
</p>

## ✨ Features

- **Official DSH inside VS Code.** Sessions, streaming responses, tool calls, approvals, and follow-up questions run through the official DSH runtime.
- **Project-aware editor context.** The active file, selected code, and `@file` or `@folder` references travel with your prompt.
- **Session controls where you need them.** Switch Permission and Plan modes, choose Model and Reasoning Effort, or steer an active task.
- **Native review and safe revert.** Review changes in VS Code's Diff Editor, Keep or Revert edits, and stop DSH before it overwrites a file with unsaved changes.
- **Extend DSH from the sidebar.** Discover and manage Tools, Skills, MCP integrations, Memory, and Agent Hooks loaded by DSH.

## 📦 Install

DSH Sidebar uses the official DeepSeek Harness runtime. If DSH is already running at `http://127.0.0.1:3080`, the extension verifies and reuses it instead of starting another process.

Otherwise, install the CLI in the same local, WSL, SSH, or container environment where the VS Code extension runs:

```sh
npm install -g @deepseek-ai/dsh
```

The extension then starts an isolated DSH Web runtime for the current VS Code workspace.

Then choose the extension channel that fits you:

### Published release

Open **Extensions** in VS Code, search for **DSH Sidebar**, and select **Install**. You can also install it from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=lixxx1.dsh-sidebar).

### Latest development build

To try features already available on `main` but not yet published to the Marketplace, build and install the latest VSIX:

```sh
git clone https://github.com/Lixxx1/dsh-vscode.git
cd dsh-vscode
pnpm install --frozen-lockfile
pnpm run package
```

In VS Code, run **Extensions: Install from VSIX...** from the Command Palette and select `dsh-vscode.vsix`. Development builds move faster and may be less stable; pull the latest changes and rebuild the VSIX to update.

Requires VS Code 1.100 or newer and Node.js `^22.19` or `>=24`.

Installing community runtime plugins also requires `pnpm` on your PATH.

## 🚀 Use

1. Open a trusted project folder in VS Code.
2. Select **DeepSeek Harness** in the right sidebar. If it is hidden, find it under **Other Views**.
3. Use the key button to configure `DEEPSEEK_API_KEY`.
4. Choose the Permission mode, Model, and Reasoning Effort, then start working. Use the Shield menu for Permission and Plan modes, `/` for official DSH commands, and `@` to add files or folders.
5. Use the plugins button in the sidebar title to search, install, inspect, or remove community runtime plugins.

💬 Found a rough edge or have an idea for what should come next? [Open an issue](https://github.com/Lixxx1/dsh-vscode/issues). I read every piece of feedback, and contributions are welcome too.

## License

[MIT](LICENSE)
