# DeepSeek Harness for VS Code

Use DeepSeek Harness as a coding assistant in the VS Code sidebar.

The goal is the same kind of workflow offered by Claude Code and Codex in VS Code: keep an assistant beside your editor while you work, with the current project, file, and selection already in context.

**English** | [简体中文](README.zh.md)

[![CI](https://github.com/Lixxx1/dsh-vscode/actions/workflows/ci.yml/badge.svg)](https://github.com/Lixxx1/dsh-vscode/actions/workflows/ci.yml)
[![MIT License](https://img.shields.io/badge/license-MIT-263146?style=flat-square)](LICENSE)
![Status](https://img.shields.io/badge/status-alpha-7da1de?style=flat-square)

<p align="center">
  <img src="media/demo.gif" alt="DeepSeek Harness in the VS Code sidebar">
</p>

## Features

- A Claude Code/Codex-style coding assistant powered by the official DeepSeek Harness runtime, always available in the VS Code right sidebar.
- Project and editor context built in: DeepSeek sees the current workspace, active file, and selected code. Use `@file`, `@folder`, or **Add Selection to Chat** for explicit context.
- Native code review: open file references and tool results in the editor, then inspect individual changes or all changed files with VS Code's Diff Editor.
- Safe collaboration with unsaved code: if DeepSeek is about to modify a dirty editor buffer, the task stops before overwriting it.
- A complete task loop inside VS Code, including streaming, tool calls, approvals, follow-up questions, project sessions, and official `/` commands.
- Queue follow-up messages while a task runs, edit or remove them, or steer the current task immediately with `Cmd/Ctrl+Enter`.
- Choose Model and Reasoning Effort separately from the composer.

## Install

Install the official DeepSeek Harness CLI first:

```sh
npm install -g @deepseek-ai/dsh
```

Then build and install the extension:

```sh
git clone https://github.com/Lixxx1/dsh-vscode.git
cd dsh-vscode
corepack pnpm install --frozen-lockfile
corepack pnpm run check
corepack pnpm run package
code --install-extension dsh-vscode.vsix
```

Requires VS Code 1.100 or newer and Node.js `^22.19` or `>=24`.

## Use

1. Open a trusted project folder in VS Code.
2. Select **DeepSeek Harness** in the right sidebar. If it is hidden, find it under **Other Views**.
3. Use the key button to configure `DEEPSEEK_API_KEY`.
4. Choose a project, conversation, Model, and Reasoning Effort, then start working. Type `/` for official DSH commands, or `@` to add files and folders.

For implementation details, see [Architecture](docs/architecture.md). To contribute, read [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
