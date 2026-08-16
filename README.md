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

A VS Code sidebar for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). It starts the real official `dsh web` Cordis profile as a child process and hosts the official DSH client inside VS Code.

There is no mock runtime, copied agent loop, or parallel session protocol. Sessions, streaming, tool cards, approvals, user questions, model selection, persistence, and permission policy remain owned by DeepSeek Harness.

> [!IMPORTANT]
> This project is an early community extension and is not an official DeepSeek product. DeepSeek Harness is under active development, so compatible DSH versions and integration details may change.

## Core capabilities

| Capability | Behavior |
|---|---|
| Activity Bar chat | Opens the official responsive DSH client in a VS Code sidebar |
| Real DSH runtime | Starts `dsh web --host 127.0.0.1 --port 0`; no simulated backend |
| Shared surfaces | Sidebar, editor tab, and browser reuse one child process |
| Official interactions | Tool presentation, approvals, questions, models, queues, and session replay come from DSH |
| Workspace ownership | DSH starts with the first VS Code workspace folder as its working directory |
| Lifecycle | Bounded startup, runtime output, restart, SIGTERM shutdown, and final forced termination |
| Remote support | Uses `vscode.env.asExternalUri` for Remote SSH, Dev Containers, and port forwarding |

## How it works

```text
VS Code Extension Host
  ├─ starts: dsh web --host 127.0.0.1 --port 0
  ├─ reads the official "dsh web: http://127.0.0.1:<port>" announcement
  └─ embeds the resolved URL in a trusted-workspace Webview

VS Code Webview
  └─ official DSH Web client
       └─ API Proxy HTTP/WebSocket carrier
            └─ Cordis services → Agents → sessions/tools/approval/persistence
```

The extension is a process and presentation adapter. It does not interpret model events or make permission decisions. See [Architecture](docs/architecture.md) for the ownership and security boundaries.

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

Reload VS Code, open a trusted folder, and select the DeepSeek whale in the Activity Bar. The extension starts DSH on the first open.

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

## Commands

- `DeepSeek Harness: Open Chat in Editor`
- `DeepSeek Harness: Restart Runtime`
- `DeepSeek Harness: Show Runtime Output`
- `DeepSeek Harness: Open in Browser`

## Development

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm run typecheck
corepack pnpm run test
corepack pnpm run build
corepack pnpm run package
```

The tests cover launch resolution and the exact official loopback URL announcement. Product code contains no mock DSH mode. A real no-prompt smoke check should start the official Web profile, request `/`, and verify graceful shutdown; sending a model prompt belongs to credentialed integration testing.

See [Contributing](CONTRIBUTING.md) before submitting a change.

## Security

- The extension is disabled in untrusted workspaces because DSH can run commands and edit files.
- The default server binds only to `127.0.0.1` on an OS-assigned port.
- Only the exact official loopback URL announcement is accepted for embedding.
- Credentials are inherited by the DSH child process; the extension does not read or forward credential values through Webview messages.
- Sandbox and approval behavior come from the selected official DSH profile. Review that profile before working with sensitive repositories.

Please report vulnerabilities according to [SECURITY.md](SECURITY.md).

## Known limitations

- The first version embeds the official responsive Web client rather than providing VS Code-native message renderers.
- One Extension Host currently follows the first workspace folder in a multi-root workspace.
- DSH must be installed separately and available to the Extension Host.
- Marketplace publishing and signed releases are not configured yet.

## License

[MIT](LICENSE)
