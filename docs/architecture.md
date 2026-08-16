# Architecture and security boundary

## Ownership

dsh-vscode owns only the VS Code integration boundary:

- locating and starting a real DSH executable;
- reading the official loopback URL announcement;
- calling the official loopback HTTP/WebSocket API from the Extension Host;
- projecting official session events into sidebar and editor Webviews;
- reporting process output and stopping the owned child.

DeepSeek Harness owns all agent semantics:

- Session logs, replay, queueing, compaction, and persistence.
- Model adapters and request assembly.
- Tool registration and execution.
- Approval and user-question protocols.
- Workspace, sandbox, filesystem, and shell policy.

The extension translates only the presentation-safe subset of `session/event` into user, assistant, and compact tool rows. It consumes the existing API Proxy contract over HTTP/WebSocket; it does not create a second agent or session protocol.

## Process lifecycle

One `DshRuntime` belongs to one VS Code Extension Host. Calls to `start()` converge on one pending startup. A successful startup accepts only `http://127.0.0.1:<port>` from the official `dsh web:` announcement. The Extension Host uses that loopback address directly; the optional browser command passes it through `vscode.env.asExternalUri`.

Sidebar and editor surfaces observe the same runtime state. Disposing a surface does not stop DSH while another surface may still use it. Extension deactivation sends SIGTERM, waits up to four seconds, then sends SIGKILL as a final convergence boundary.

## Trust boundary

The extension declares trusted-workspace-only support because the official DSH profile can expose command and file tools. Loopback and the DSH carrier's own Host checks remain the network boundary. The Webview cannot reach the DSH origin; it exchanges typed UI messages only with the Extension Host.

The Extension Host inherits the user's environment into the DSH child, which is how the official CLI normally receives credentials. An optional extension-managed key is stored in VS Code SecretStorage and added only to the child's environment. Credential values are never sent through Webview `postMessage`.

## Why use the Web profile as a backend?

The official repository already exposes a complete API Proxy contract. A new stdio protocol would need to duplicate approvals, questions, tool views, session replay, queues, subagent state, models, and error semantics. The extension therefore starts the shipped Web profile only for its backend transport while owning all visible UI.

## Known limitations

- The first demo renders text messages and compact tool status only; richer official interaction views remain to be implemented.
- Runtime ownership is per Extension Host rather than per folder in a multi-root workspace.
- The extension recognizes the official loopback announcement and intentionally rejects arbitrary external URLs.
