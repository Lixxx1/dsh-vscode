# Changelog

All notable changes to dsh-vscode are documented here.

## 0.1.1

- Add a VS Code-native, paste-capable API key prompt for the nested DSH client.
- Store the key in VS Code SecretStorage and expose it only to the official DSH child process.
- Add a command to remove the extension-managed credential.
- Use the official DeepSeek activity icon from the DeepSeek Harness repository.

## 0.1.0

- Add the DeepSeek Harness Activity Bar sidebar.
- Start one real official `dsh web` Cordis runtime per Extension Host.
- Reuse the official DSH Web client for sessions, streaming, tools, approvals, questions, models, and persistence.
- Add editor-tab and external-browser surfaces over the same runtime.
- Add restart, output, bounded startup, source-checkout discovery, and graceful shutdown.
