# Architecture and security boundary

## Ownership

dsh-vscode owns only the VS Code integration boundary:

- locating and starting a real DSH executable;
- reading the official loopback URL announcement;
- resolving that URL through VS Code's remote-port abstraction;
- hosting the official client in sidebar and editor Webviews;
- reporting process output and stopping the owned child.

DeepSeek Harness owns all agent semantics:

- Session logs, replay, queueing, compaction, and persistence.
- Model adapters and request assembly.
- Tool registration, execution, and presentation.
- Approval and user-question protocols.
- Workspace, sandbox, filesystem, and shell policy.

The extension therefore does not translate `session/event` itself. The embedded official client consumes the existing API Proxy contract over its HTTP/WebSocket carrier.

## Process lifecycle

One `DshRuntime` belongs to one VS Code Extension Host. Calls to `start()` converge on one pending startup. A successful startup accepts only `http://127.0.0.1:<port>` from the official `dsh web:` announcement and passes it through `vscode.env.asExternalUri`.

Sidebar and editor surfaces observe the same runtime state. Disposing a surface does not stop DSH while another surface may still use it. Extension deactivation sends SIGTERM, waits up to four seconds, then sends SIGKILL as a final convergence boundary.

## Trust boundary

The extension declares trusted-workspace-only support because the official DSH profile can expose command and file tools. Loopback and the DSH Web carrier's own Host/Origin checks remain the network boundary. The outer Webview CSP allows only the resolved DSH origin as a frame source.

The Extension Host inherits the user's environment into the DSH child, which is how the official CLI normally receives credentials. Credential values are never inspected, persisted, or sent through `postMessage` by dsh-vscode.

## Why not a new stdio protocol?

The official repository already has a complete GUI contract and client projection layer. A new protocol would need to duplicate approvals, questions, tool views, session replay, queues, subagent state, models, and error semantics. Embedding the official client keeps the initial extension behavior aligned with DSH while leaving a future VS Code-native renderer free to consume the same API Proxy contract.

## Known limitations

- The official Web layout, not VS Code-native React components, renders the conversation.
- Runtime ownership is per Extension Host rather than per folder in a multi-root workspace.
- The extension recognizes the official loopback announcement and intentionally rejects arbitrary external URLs.
