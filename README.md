<p align="center">
  <strong>DeepSeek Harness for VS Code</strong>
</p>

<p align="center">
  <strong>English</strong> | <a href="README.zh.md">简体中文</a>
</p>

<p align="center">
  <a href="https://github.com/Lixxx1/dsh-vscode/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/Lixxx1/dsh-vscode/actions/workflows/ci.yml/badge.svg"></a>
  <a href="LICENSE"><img alt="MIT License" src="https://img.shields.io/badge/license-MIT-263146?style=flat-square"></a>
  <img alt="Status" src="https://img.shields.io/badge/status-alpha-7da1de?style=flat-square">
  <img alt="VS Code" src="https://img.shields.io/badge/VS%20Code-%3E%3D%201.100-4b6fff?style=flat-square">
</p>

# dsh-vscode

A project-aware VS Code chat sidebar for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). It renders its own Copilot-style interface and uses the real official `dsh web` Cordis profile as a local backend process.

There is no mock runtime, copied agent loop, or parallel session protocol. Sessions, streaming, tools, models, persistence, and permission policy remain owned by DeepSeek Harness; the extension consumes its existing HTTP/WebSocket API.

> [!IMPORTANT]
> This project is an early community extension and is not an official DeepSeek product. DeepSeek Harness is under active development, so compatible DSH versions and integration details may change.

## Core capabilities

| Capability | Behavior |
|---|---|
| Secondary Sidebar chat | Opens a compact, Copilot-style chat surface on the right with no nested app navigation |
| Real DSH runtime | Starts `dsh web --host 127.0.0.1 --port 0`; no simulated backend |
| Project sessions | Lists and creates only sessions whose `cwd` is the current VS Code workspace |
| Real protocol | Loads history and models over official RPC and receives live events over official WebSockets |
| Shared surfaces | Sidebar and editor tab reuse one child process and one project conversation state |
| Workspace ownership | DSH starts with the first VS Code workspace folder as its working directory; new sessions use that exact `cwd` |
| Lifecycle | Bounded startup, runtime output, restart, SIGTERM shutdown, and final forced termination |
| Remote support | Uses `vscode.env.asExternalUri` for Remote SSH, Dev Containers, and port forwarding |

## How it works

```text
VS Code Extension Host
  ├─ starts: dsh web --host 127.0.0.1 --port 0
  ├─ reads the official "dsh web: http://127.0.0.1:<port>" announcement
  ├─ sends session/model/prompt RPC over loopback HTTP
  └─ consumes session and host events over loopback WebSockets

VS Code Webview
  └─ dsh-vscode project chat UI
       └─ postMessage boundary to the Extension Host
            └─ official DSH API → Cordis services → Agent/session/tools/persistence
```

The extension is a process and presentation adapter. It projects official session events into chat rows, but does not run the agent or make permission decisions. See [Architecture](docs/architecture.md) for the ownership and security boundaries.

## Prerequisites

- VS Code 1.100 or newer.
- Node.js `^22.19` or `>=24`.
- The official `dsh` CLI installed and configured.
- A model credential such as `DEEPSEEK_API_KEY` when you send real prompts.

Install the official CLI and confirm that its Web profile starts:

```sh
npm install -g @deepseek-ai/dsh
dsh web --host 127.0.0.1 --port 0
```

## Install from source

The first release is source-installable while VS Marketplace packaging is prepared:

```sh
git clone https://github.com/Lixxx1/dsh-vscode.git
cd dsh-vscode
corepack pnpm install --frozen-lockfile
corepack pnpm run build
corepack pnpm run package
code --install-extension dsh-vscode.vsix
```

Reload VS Code, open a trusted folder, and select **DeepSeek Harness** in the right Secondary Sidebar. If several chat extensions share that area, open **Other Views** and choose DeepSeek Harness once. The extension starts DSH on the first open.

For extension development, open this repository in VS Code and press `F5`. The included Extension Development Host configuration builds the extension first.

## Configuration

| Setting | Default | Purpose |
|---|---|---|
| `deepseekHarness.executable` | empty | Explicit DSH executable; empty uses `dsh` from `PATH` |
| `deepseekHarness.arguments` | `web --host 127.0.0.1 --port 0` | Arguments passed to DSH |
| `deepseekHarness.autoStart` | `true` | Start when the sidebar opens |
| `deepseekHarness.startupTimeout` | `60000` | Startup deadline in milliseconds |

If a GUI-launched VS Code cannot see your shell-installed `dsh`, set an absolute executable path:

```json
{
  "deepseekHarness.executable": "/opt/homebrew/bin/dsh"
}
```

### Pasting and API keys

The custom composer is a normal Webview `textarea`, so `Cmd/Ctrl+V` works directly without a clipboard bridge or custom keybinding.

The key icon and **DeepSeek Harness: Configure API Key** command use a native VS Code password input that supports paste. The value is stored in VS Code SecretStorage and exposed only as `DEEPSEEK_API_KEY` to the official DSH child process. Use **DeepSeek Harness: Clear Stored API Key** to remove an extension-managed key.

## Commands

- `DeepSeek Harness: Open Chat in Editor`
- `DeepSeek Harness: Restart Runtime`
- `DeepSeek Harness: Show Runtime Output`
- `DeepSeek Harness: Open in Browser`
- `DeepSeek Harness: Configure API Key`
- `DeepSeek Harness: Clear Stored API Key`

## Development

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm run typecheck
corepack pnpm run test
corepack pnpm run build
corepack pnpm run package
```

The tests cover launch resolution, credentials, event-to-message projection, and the exact official loopback URL announcement. Product code contains no mock DSH mode. A real no-prompt smoke check starts the official profile and loads an existing workspace session; sending a model prompt belongs to credentialed integration testing.

See [Contributing](CONTRIBUTING.md) before submitting a change.

## Security

- The extension is disabled in untrusted workspaces because DSH can run commands and edit files.
- The default server binds only to `127.0.0.1` on an OS-assigned port.
- Only the exact official loopback URL announcement is accepted as the backend address.
- Credentials come from the inherited environment or VS Code SecretStorage and are passed only to the DSH child process; they are never sent to the chat Webview.
- Sandbox and approval behavior come from the selected official DSH profile. Review that profile before working with sensitive repositories.

Please report vulnerabilities according to [SECURITY.md](SECURITY.md).

## Known limitations

- Approval prompts, user-question forms, rich tool presenters, attachments, and older-history pagination are not rendered in the first demo yet.
- The first demo uses a safe plain-text conversation renderer rather than Markdown and rich media.
- One Extension Host currently follows the first workspace folder in a multi-root workspace.
- DSH must be installed separately and available to the Extension Host.
- Marketplace publishing and signed releases are not configured yet.

## License

[MIT](LICENSE)
