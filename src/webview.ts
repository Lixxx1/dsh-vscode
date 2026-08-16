import * as vscode from 'vscode'

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function nonce(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  let value = ''
  for (let index = 0; index < 32; index += 1) {
    value += alphabet.charAt(Math.floor(Math.random() * alphabet.length))
  }
  return value
}

export function loadingHtml(webview: vscode.Webview, detail: string): string {
  return messageHtml(webview, 'Starting DeepSeek Harness', detail, false)
}

export function errorHtml(webview: vscode.Webview, message: string): string {
  return messageHtml(webview, 'DeepSeek Harness could not start', message, true)
}

function messageHtml(webview: vscode.Webview, title: string, detail: string, retry: boolean): string {
  const token = nonce()
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${token}';">
  <style>
    html, body { height: 100%; margin: 0; }
    body { display: grid; place-items: center; color: var(--vscode-foreground); background: var(--vscode-sideBar-background); font-family: var(--vscode-font-family); }
    main { width: min(28rem, calc(100% - 2rem)); text-align: center; }
    .mark { width: 2.5rem; height: 2.5rem; margin: 0 auto 1rem; border: 2px solid var(--vscode-progressBar-background); border-top-color: transparent; border-radius: 50%; animation: spin 1s linear infinite; }
    h2 { margin: 0 0 .65rem; font-size: 1rem; font-weight: 600; }
    p { margin: 0; color: var(--vscode-descriptionForeground); line-height: 1.45; overflow-wrap: anywhere; }
    button { margin-top: 1rem; padding: .45rem .8rem; border: 0; border-radius: 2px; color: var(--vscode-button-foreground); background: var(--vscode-button-background); cursor: pointer; }
    button:hover { background: var(--vscode-button-hoverBackground); }
    .links { display: flex; justify-content: center; gap: .5rem; }
    @keyframes spin { to { transform: rotate(360deg); } }
  </style>
</head>
<body>
  <main>
    <div class="mark" aria-hidden="true"></div>
    <h2>${escapeHtml(title)}</h2>
    <p>${escapeHtml(detail)}</p>
    ${retry ? '<div class="links"><button data-command="restart">Restart</button><button data-command="output">Show output</button></div>' : ''}
  </main>
  <script nonce="${token}">
    const vscode = acquireVsCodeApi();
    document.querySelectorAll('[data-command]').forEach((button) => {
      button.addEventListener('click', () => vscode.postMessage({ type: button.dataset.command }));
    });
  </script>
</body>
</html>`
}

export function appHtml(webview: vscode.Webview, uri: vscode.Uri): string {
  const token = nonce()
  const source = escapeHtml(uri.toString(true))
  const origin = escapeHtml(new URL(uri.toString(true)).origin)
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src ${origin}; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${token}';">
  <style>
    html, body, iframe { width: 100%; height: 100%; margin: 0; border: 0; overflow: hidden; background: var(--vscode-sideBar-background); }
    #loading { position: fixed; inset: 0; display: grid; place-items: center; color: var(--vscode-descriptionForeground); background: var(--vscode-sideBar-background); font: 13px var(--vscode-font-family); z-index: 1; }
    body.loaded #loading { display: none; }
  </style>
</head>
<body>
  <div id="loading">Connecting to DeepSeek Harness…</div>
  <iframe
    title="DeepSeek Harness"
    src="${source}"
    sandbox="allow-same-origin allow-scripts allow-forms allow-downloads allow-popups allow-modals"
    allow="clipboard-read; clipboard-write"
  ></iframe>
  <script nonce="${token}">
    document.querySelector('iframe').addEventListener('load', () => document.body.classList.add('loaded'));
  </script>
</body>
</html>`
}
