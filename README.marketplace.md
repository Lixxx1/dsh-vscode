# DSH Sidebar 🐋

> [!NOTE]
> ⭐ Like DSH Sidebar? [Give it a Star on GitHub](https://github.com/Lixxx1/dsh-vscode)! It helps more people find the project.
>
> GitHub: https://github.com/Lixxx1/dsh-vscode

Bring DeepSeek Harness into the place where you already write, run, and review code.

DSH Sidebar gives you a project-aware assistant in the VS Code right sidebar, with an experience familiar to Claude Code and Codex. Ask DeepSeek to inspect a repository, change files, run tools, and verify the result without leaving your editor.

<p align="center">
  <img src="media/demo.gif" alt="DeepSeek Harness working in the VS Code sidebar">
</p>

## ✨ What you can do

- **Autonomous VS Code debugging.** Let DeepSeek launch the current project from `.vscode/launch.json`, manage breakpoints, step through execution, and inspect stack frames and local variables using VS Code's native debugger.
- **Work with the official DSH runtime.** Sessions, streaming responses, tool calls, approvals, and follow-up questions stay inside VS Code.
- **Bring in editor context.** The active file and selected code can travel with your prompt. Use `@file` or `@folder` to add more context.
- **Control each session.** Switch Permission and Plan modes, choose Model and Reasoning Effort, and steer a task while it is running.
- **Review edits natively.** Open changes in VS Code's Diff Editor, then Keep or safely Revert them. DSH stops before overwriting a file with unsaved editor changes.
- **Extend DSH from the sidebar.** Discover and manage Tools, Skills, MCP integrations, Memory, and Agent Hooks loaded by DSH.

## 📦 Before you start

DSH Sidebar runs the official DeepSeek Harness CLI on your machine. Install it first:

```sh
npm install -g @deepseek-ai/dsh
```

You need VS Code 1.100 or newer and Node.js `^22.19` or `>=24`.

## 🚀 Get started

1. Open a trusted project folder in VS Code.
2. Select **DeepSeek Harness** in the right sidebar. If it is hidden, find it under **Other Views**.
3. Select the key button and enter your `DEEPSEEK_API_KEY`.
4. Choose a Permission mode, Model, and Reasoning Effort, then send your first task.

Use the Shield menu for Permission and Plan modes, `/` for official DSH commands, `@` for files and folders, and the plugins button to manage runtime extensions.

### Autonomous debugging

Enable **DeepSeek Harness: Autonomous Debugging** in VS Code Settings and add a debug configuration to `.vscode/launch.json`.

DeepSeek can then start the debugger, set breakpoints, step through execution, inspect runtime values, fix the code, and verify the result directly from the sidebar.

Requires DeepSeek Harness `0.1.0-rc.8` or newer.

## 💬 Feedback

If something feels awkward or you have an idea for the next feature, come say hi in [GitHub Issues](https://github.com/Lixxx1/dsh-vscode/issues). PRs are welcome too!

[Website](https://lixxx1.github.io/dsh-vscode/) · [GitHub](https://github.com/Lixxx1/dsh-vscode)
