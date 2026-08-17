# DeepSeek Harness for VS Code

Bring DeepSeek Harness into the same place you write code. dsh-vscode gives DSH a Claude Code/Codex-style right sidebar that already understands your project, active file, and selected code.

Ask DeepSeek to inspect, change, and verify code without switching between your editor, terminal, and a separate chat window.

**English** | [简体中文](README.zh.md)

[![CI](https://github.com/Lixxx1/dsh-vscode/actions/workflows/ci.yml/badge.svg)](https://github.com/Lixxx1/dsh-vscode/actions/workflows/ci.yml)
[![VS Code Marketplace](https://img.shields.io/visual-studio-marketplace/v/lixxx1.dsh-sidebar?style=flat-square&label=VS%20Code%20Marketplace&color=4d6bfe)](https://marketplace.visualstudio.com/items?itemName=lixxx1.dsh-sidebar)
[![MIT License](https://img.shields.io/badge/license-MIT-263146?style=flat-square)](LICENSE)
![Status](https://img.shields.io/badge/status-alpha-7da1de?style=flat-square)

<p align="center">
  <img src="media/demo.gif" alt="DeepSeek Harness in the VS Code sidebar">
</p>

## Features

- **Work with the real DSH runtime.** Sessions, streaming, tool calls, approvals, follow-up questions, and official `/` commands stay inside the VS Code sidebar.
- **Extend DSH from VS Code.** Search and install community Tools, Skills, MCP integrations, Memory, and Agent Hooks. Plugins are added to the official `web` profile and loaded by DSH after restart.
- **Start with the right context.** DeepSeek receives the current workspace, active file, and selected code. Add specific files or folders with `@`, or pin a selection with **Add Selection to Chat**.
- **Control every session.** Switch official Permission and Plan modes from the composer, then choose Model and Reasoning Effort independently.
- **Review edits where you code.** Changed files are grouped by turn with `+/-` line counts. Open them in VS Code's native Diff Editor, then Keep or safely Revert individual files or the full change set.
- **Stay in control while DeepSeek works.** Queue, edit, remove, or steer follow-up messages. If DeepSeek reaches a dirty editor buffer, the task stops before overwriting your unsaved work.

## Install

Install the official DeepSeek Harness CLI:

```sh
npm install -g @deepseek-ai/dsh
```

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

## Use

1. Open a trusted project folder in VS Code.
2. Select **DeepSeek Harness** in the right sidebar. If it is hidden, find it under **Other Views**.
3. Use the key button to configure `DEEPSEEK_API_KEY`.
4. Choose the Permission mode, Model, and Reasoning Effort, then start working. Use the Shield menu for Permission and Plan modes, `/` for official DSH commands, and `@` to add files or folders.
5. Use the plugins button in the sidebar title to search, install, inspect, or remove community runtime plugins.

## License

[MIT](LICENSE)
