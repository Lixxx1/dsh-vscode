# Contributing

Thanks for improving dsh-vscode.

## Setup

```sh
corepack enable
corepack pnpm install --frozen-lockfile
corepack pnpm run check
```

Open the repository in VS Code and run the `Run DeepSeek Harness Extension` launch configuration. The Extension Development Host needs a real official `dsh` executable; product development must not add a mock runtime or silently replace DSH behavior.

## Design rules

- Keep agent, session, tool, approval, and persistence semantics in DeepSeek Harness.
- Prefer existing official DSH contracts over a second local protocol.
- Keep child-process startup and shutdown bounded.
- Do not expose the DSH server beyond loopback by default.
- Never place credential values in logs or Webview messages.
- Add tests for launch parsing and lifecycle changes.
- Update both README languages when user-facing behavior changes.

## Pull requests

Before opening a PR, run:

```sh
corepack pnpm run typecheck
corepack pnpm run test
corepack pnpm run build
corepack pnpm run package
```

Explain the user-visible change, the DSH version tested, and any security or lifecycle impact.
