# Changelog

All notable changes to dsh-vscode are documented here.

## Unreleased

- Replace the embedded official Web client with a custom Copilot-style project chat UI.
- Scope session listing and creation to the current VS Code workspace `cwd`.
- Load real history/models over the official DSH HTTP API and consume live events over its WebSocket transport.
- Support native `Cmd/Ctrl+V` in the custom composer without a clipboard bridge.
- Add a VS Code-native, paste-capable API key prompt.
- Store the key in VS Code SecretStorage and expose it only to the official DSH child process.
- Add a command to remove the extension-managed credential.
- Use the official DeepSeek activity icon from the DeepSeek Harness repository.

- Add the DeepSeek Harness chat in VS Code's right Secondary Sidebar.
- Start one real official `dsh web` Cordis runtime per Extension Host.
- Reuse the official DSH runtime and protocol for sessions, streaming, tools, models, and persistence.
- Add editor-tab and external-browser surfaces over the same runtime.
- Add restart, output, bounded startup, source-checkout discovery, and graceful shutdown.
