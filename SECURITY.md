# Security policy

## Reporting a vulnerability

Please do not open a public issue for a suspected vulnerability. Use GitHub's private vulnerability reporting for this repository when available, or contact the repository owner privately through their GitHub profile.

Include the affected version, operating system, VS Code version, DSH version, reproduction steps, and the expected impact. Do not include live API keys, tokens, private session logs, or other credentials.

## Supported versions

dsh-vscode is currently in alpha. Security fixes target the latest release on the default branch.

## Boundary

dsh-vscode starts the official DSH runtime and embeds its official Web client. Reports about DSH's agent, tool, sandbox, model, or API Proxy implementation may belong in the [DeepSeek Harness repository](https://github.com/deepseek-ai/deepseek-harness). Reports about executable discovery, child-process ownership, Webview CSP, URL acceptance, or VS Code integration belong here.
